import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { PermissionCatalogService } from '../../acl/permission-catalog.service.js';
import { ConnectionRegistry } from '../connection-registry.js';
import { TenantRouting } from '../control/tenant-routing.model.js';
import { quoteIdent, type Placement } from '../context.js';
import { markTx } from '../guards.js';
import { tenantModelsOf } from '../model-binding.js';
import { appliedNames } from '../../migrations/meta.js';
import { PARTITION, partitionColumnOf } from '../partition.js';
import { PlacementResolver } from '../placement.js';
import { SchemaSync } from '../schema-sync.js';
import { TenantRunner } from '../tenant-runner.js';
import { buildCopyPlan, type TablePlan } from './copy-plan.js';
import { count, insertRows, linkSelf, mapTable, qualified, readRows, remapColumn, storeMap, type Row } from './copy-sql.js';

export interface MoveOptions {
  companyId: number;
  to: { dbKey: string; schema: string };
  /** Keep the company's rows in the old place after the switch (a copy instead of a move). */
  keepSource?: boolean;
}

export interface MoveReport {
  companyId: number;
  from: Placement;
  to: Placement;
  /** Rows copied per table. */
  tables: Record<string, number>;
}

/**
 * Moves one company to another schema or database (or merges it into one that already holds other
 * companies), by copying its rows with new ids. Only the model declarations are used: real foreign
 * keys are translated while inserting, soft and polymorphic references afterwards, reference tables
 * (permissions) are matched by natural key. The copy and its check run in ONE target transaction, so
 * a failure leaves the target untouched; the route switches (new epoch, so signed-in tokens must be
 * renewed) only after that commits, and the old rows are removed last.
 *
 * While it runs the route is `migrating` and every request of the company gets 503. The copy starts
 * only after every process has dropped its cached route (`PlacementResolver.changed`).
 */
@Injectable()
export class CompanyMover {
  private readonly logger = new Logger('CompanyMover');

  constructor(
    @InjectModel(TenantRouting) private readonly routing: typeof TenantRouting,
    private readonly registry: ConnectionRegistry,
    private readonly placements: PlacementResolver,
    private readonly schemas: SchemaSync,
    private readonly runner: TenantRunner,
    private readonly catalog: PermissionCatalogService,
  ) {}

  async move({ companyId, to, keepSource }: MoveOptions): Promise<MoveReport> {
    const route = await this.routing.findOne({ where: { companyId } });
    if (!route) throw new NotFoundException('Company not found');
    if (route.status !== 'active') throw new ConflictException(`Company is ${route.status}`);
    const from: Placement = { dbKey: route.dbKey, schema: route.schema, epoch: route.epoch };
    if (from.dbKey === to.dbKey && from.schema === to.schema) throw new ConflictException('Company is already there');

    const source = await this.registry.get(from.dbKey);
    const target = await this.registry.get(to.dbKey);
    const plan = buildCopyPlan(tenantModelsOf(target));
    await this.schemas.syncTenant(to.dbKey, to.schema);
    await this.assertSameMigrations(source, from, target, to);
    await this.runner.run({ companyId: 0 }, () => this.catalog.sync(), { placement: { ...to, epoch: 0 } });

    await route.update({ status: 'migrating' });
    // Every process must stop writing to the source before the snapshot below is taken; a process
    // still holding the old route would otherwise write rows the copy never sees.
    await this.placements.changed(companyId);
    let switched = false;
    try {
      const tables = await this.copy(source, from, target, to, plan, companyId);
      await route.update({ dbKey: to.dbKey, schema: to.schema, epoch: route.epoch + 1, status: 'active' });
      switched = true;
      await this.placements.changed(companyId, { wait: false });
      if (!keepSource) await this.purge(source, from, plan, companyId);
      this.logger.log(`Company ${companyId} moved ${from.dbKey}.${from.schema} -> ${to.dbKey}.${to.schema}`);
      return { companyId, from, to: { ...to, epoch: route.epoch }, tables };
    } finally {
      if (!switched) {
        await route.update({ status: 'active' });
        await this.placements.changed(companyId, { wait: false });
      }
    }
  }

  /** Both places must have exactly the same migrations, or the copy could lose or misplace columns. */
  private async assertSameMigrations(source: Sequelize, from: Placement, target: Sequelize, to: { dbKey: string; schema: string }): Promise<void> {
    const [have, want] = await Promise.all([appliedNames(target, to.schema), appliedNames(source, from.schema)]);
    const missing = [...want].filter((name) => !have.has(name));
    const extra = [...have].filter((name) => !want.has(name));
    if (missing.length || extra.length) {
      throw new ConflictException(
        `${from.dbKey}.${from.schema} and ${to.dbKey}.${to.schema} are at different migrations` +
          `${missing.length ? ` (target lacks ${missing.join(', ')})` : ''}${extra.length ? ` (source lacks ${extra.join(', ')})` : ''}. Run the migration job first.`,
      );
    }
  }

  private async copy(source: Sequelize, from: Placement, target: Sequelize, to: { dbKey: string; schema: string }, plan: TablePlan[], companyId: number): Promise<Record<string, number>> {
    const report: Record<string, number> = {};
    // Source read transaction first; it is only read from, and ends when the copy ends.
    return source.transaction({ isolationLevel: 'REPEATABLE READ' as never }, async (src) => {
      markTx(src, { kind: 'tenant', dbKey: from.dbKey });
      return target.transaction(async (tgt) => {
        markTx(tgt, { kind: 'tenant', dbKey: to.dbKey });
        const copied: TablePlan[] = [];
        for (const step of plan) {
          if (step.kind === 'mirror') await this.copyMirror(source, src, from.schema, target, tgt, to.schema, step, companyId);
          else if (step.kind === 'reference') await this.mapReference(source, src, from.schema, target, tgt, to.schema, step);
          else {
            report[step.table] = await this.copyTable(source, src, from.schema, target, tgt, to.schema, step, companyId);
            copied.push(step);
          }
        }
        for (const step of copied) for (const remap of step.later) await remapColumn(target, tgt, to.schema, step.table, partitionColumnOf(step.model as never), companyId, remap);
        for (const step of copied) {
          const [have, want] = [await count(target, tgt, to.schema, step.table, partitionColumnOf(step.model as never), companyId), report[step.table]];
          if (have !== want) throw new Error(`Move check failed for ${step.table}: copied ${want}, found ${have}`);
        }
        return report;
      });
    });
  }

  private async copyMirror(source: Sequelize, src: Transaction, fromSchema: string, target: Sequelize, tgt: Transaction, toSchema: string, step: TablePlan, companyId: number): Promise<void> {
    const rows = (await source.query(`SELECT ${step.columns.map(quoteIdent).join(', ')} FROM ${qualified(fromSchema, step.table)} WHERE id = $1`, { type: QueryTypes.SELECT, transaction: src, bind: [companyId] })) as Row[];
    const existing = (await target.query(`SELECT 1 FROM ${qualified(toSchema, step.table)} WHERE id = $1`, { type: QueryTypes.SELECT, transaction: tgt, bind: [companyId] })) as unknown[];
    if (existing.length) throw new ConflictException('The company already exists in the target');
    if (rows.length === 0) throw new NotFoundException('Company has no row in its schema');
    await insertRows(target, tgt, toSchema, step.table, rows);
  }

  /** Same rows in every schema: old id to new id by natural key. */
  private async mapReference(source: Sequelize, src: Transaction, fromSchema: string, target: Sequelize, tgt: Transaction, toSchema: string, step: TablePlan): Promise<void> {
    const key = quoteIdent(step.naturalKey as string);
    const sourceRows = (await source.query(`SELECT id, ${key} AS k FROM ${qualified(fromSchema, step.table)}`, { type: QueryTypes.SELECT, transaction: src })) as Array<{ id: number; k: string }>;
    const targetRows = (await target.query(`SELECT id, ${key} AS k FROM ${qualified(toSchema, step.table)}`, { type: QueryTypes.SELECT, transaction: tgt })) as Array<{ id: number; k: string }>;
    const byKey = new Map(targetRows.map((row) => [row.k, row.id]));
    const pairs = sourceRows.flatMap((row): Array<[number, number]> => (byKey.has(row.k) ? [[row.id, byKey.get(row.k) as number]] : []));
    await storeMap(target, tgt, step.table, pairs);
  }

  private async copyTable(source: Sequelize, src: Transaction, fromSchema: string, target: Sequelize, tgt: Transaction, toSchema: string, step: TablePlan, companyId: number): Promise<number> {
    const pairs: Array<[number, number]> = [];
    const selfLinks = new Map<string, Array<[number, number]>>(step.selfColumns.map((column) => [column, []]));
    let copiedRows = 0;
    for await (const batch of readRows(source, src, fromSchema, step.table, step.columns, partitionColumnOf(step.model as never), companyId, step.hasId)) {
      const parents = batch.map((row) => Object.fromEntries(step.selfColumns.map((column) => [column, row[column]])));
      const rows = batch.map((row) => {
        const { id: _id, ...rest } = row;
        const values: Row = step.hasId ? rest : { ...row };
        for (const column of step.selfColumns) values[column] = null;
        return values;
      });
      const ids = await insertRows(target, tgt, toSchema, step.table, await this.translateInline(target, tgt, step, rows), step.hasId);
      if (step.hasId) {
        batch.forEach((row, index) => {
          pairs.push([row.id as number, ids[index] as number]);
          for (const column of step.selfColumns) {
            const parent = parents[index]?.[column];
            if (typeof parent === 'number') selfLinks.get(column)?.push([ids[index] as number, parent]);
          }
        });
      }
      copiedRows += batch.length;
    }
    if (step.hasId) await storeMap(target, tgt, step.table, pairs);
    for (const [column, links] of selfLinks) await linkSelf(target, tgt, toSchema, step.table, column, links);
    return copiedRows;
  }

  private async translateInline(target: Sequelize, tgt: Transaction, step: TablePlan, rows: Row[]): Promise<Row[]> {
    if (rows.length === 0 || step.inline.length === 0) return rows;
    for (const remap of step.inline) {
      const olds = [...new Set(rows.map((row) => row[remap.column]).filter((v): v is number => typeof v === 'number'))];
      if (olds.length === 0) continue;
      const found = (await target.query(`SELECT old_id, new_id FROM ${mapTable(remap.table as string)} WHERE old_id = ANY($1::int[])`, { type: QueryTypes.SELECT, transaction: tgt, bind: [olds] })) as Array<{ old_id: number; new_id: number }>;
      const byOld = new Map(found.map((row) => [row.old_id, row.new_id]));
      for (const row of rows) {
        const old = row[remap.column];
        if (typeof old !== 'number') continue;
        const next = byOld.get(old);
        if (next === undefined) throw new Error(`${step.table}.${remap.column} = ${old} points at a row of "${remap.table}" that was not copied`);
        row[remap.column] = next;
      }
    }
    return rows;
  }

  /** Removes the company's rows from the old place, children first, then its mirror row. */
  private async purge(source: Sequelize, from: Placement, plan: TablePlan[], companyId: number): Promise<void> {
    await source.transaction(async (t) => {
      markTx(t, { kind: 'tenant', dbKey: from.dbKey });
      for (const step of [...plan].reverse()) {
        if (step.kind === 'partitioned') await source.query(`DELETE FROM ${qualified(from.schema, step.table)} WHERE ${quoteIdent(partitionColumnOf(step.model as never))} = $1`, { transaction: t, bind: [companyId] });
      }
      await source.query(`DELETE FROM ${qualified(from.schema, PARTITION.mirror)} WHERE id = $1`, { transaction: t, bind: [companyId] });
    });
  }
}
