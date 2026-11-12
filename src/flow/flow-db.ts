import { Injectable, InternalServerErrorException, UnprocessableEntityException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { literal, Op, QueryTypes, Utils, type Transaction, type WhereOptions } from 'sequelize';
import { PARTITION } from '../tenancy/partition.js';
import type { Model, ModelCtor } from 'sequelize-typescript';
import { ScopeRegistry } from '../acl/scope-registry.js';
import type { Actor, ReqCtx } from '../auth/auth-user.js';
import { preparedFor, RowGuardRegistry } from '../crud/row-guard.js';
import { currentTenant } from '../tenancy/context.js';
import { sequelizeOf } from '../tenancy/guards.js';
import { asSystem, operationAccess } from '../crud/write-guard.js';

export type Row = Record<string, unknown>;

/**
 * Who a data step acts for. Every read and write of a flow is limited the way the operation is:
 *  - the tenant: always (the models pin the company and the schema; there is no raw SQL);
 *  - the caller's data scope (branch, own, the branches a grant names): unless the step says
 *    `asSystem: true`, which the flow document shows;
 *  - the row guards of the model written (period lock...): always, as for that model's own writes.
 */
export interface FlowAccess {
  ctx: ReqCtx<Actor>;
  /** `asSystem: true` on the step: the caller's data scope does not limit it. */
  system: boolean;
  can(code: string): Promise<boolean>;
}

/**
 * The data operations flow steps use, by model name, inside the operation's transaction. The
 * framework's implementation goes through the tenant's models; tests give
 * `fakeOpContext({ services: [[FlowDb, fake]] })`.
 */
export abstract class FlowDb {
  abstract hasModel(model: string): boolean;
  abstract findOne(t: Transaction, access: FlowAccess, model: string, where: Row, attributes?: string[]): Promise<Row | null>;
  abstract findAll(t: Transaction, access: FlowAccess, model: string, where: Row, options?: { attributes?: string[]; limit?: number }): Promise<Row[]>;
  abstract count(t: Transaction, access: FlowAccess, model: string, where: WhereOptions): Promise<number>;
  /** Whether each probe finds a row, in probe order. Default: one count each; the framework's: one statement. */
  async existsEach(t: Transaction, access: FlowAccess, probes: Array<{ model: string; where: WhereOptions }>): Promise<boolean[]> {
    const found: boolean[] = [];
    for (const probe of probes) found.push((await this.count(t, access, probe.model, probe.where)) > 0);
    return found;
  }
  abstract create(t: Transaction, access: FlowAccess, model: string, values: Row): Promise<Row>;
  /** Many new rows in one insert; the saved rows come back in the same order. */
  abstract createMany(t: Transaction, access: FlowAccess, model: string, rows: Row[]): Promise<Row[]>;
  abstract update(t: Transaction, access: FlowAccess, model: string, values: Row, where: Row): Promise<number>;
  abstract destroy(t: Transaction, access: FlowAccess, model: string, where: Row): Promise<number>;
}

/** Hard cap on rows a flow step may load or change at once. */
export const FLOW_ROW_LIMIT = 5_000;

/** A plain row with the `get` a guard calls on a model instance. */
const asRow = (values: Row): Model => ({ ...values, get: (key: string) => values[key] }) as unknown as Model;

const refused = (message: string, code: string, refType?: string) =>
  new UnprocessableEntityException({ message, errors: {}, blockers: [{ code, message, ...(refType ? { refType } : {}) }] });

@Injectable()
export class SequelizeFlowDb extends FlowDb {
  constructor(
    private readonly scopes: ScopeRegistry,
    private readonly guards: RowGuardRegistry,
    private readonly moduleRef: ModuleRef,
  ) {
    super();
  }

  private model(name: string, t?: Transaction): ModelCtor<Model> {
    const sequelize = t ? sequelizeOf(t) : currentTenant()?.sequelize;
    const model = sequelize?.models[name] as ModelCtor<Model> | undefined;
    if (!model) throw new InternalServerErrorException(`Flow: unknown model "${name}"`);
    return model;
  }

  hasModel(name: string): boolean {
    try {
      return Boolean(this.model(name));
    } catch {
      return false;
    }
  }

  /**
   * `where` limited to the caller's scope on this model (unless the step acts as the system):
   * inside an operation, the operation's own model by the whole scope, other models by a related
   * (branch) scope only, the same rule writes follow.
   */
  private scoped(access: FlowAccess, model: ModelCtor<Model>, where: WhereOptions): WhereOptions {
    if (access.system) return where;
    const scope = this.scopes.where(access.ctx as ReqCtx, model, operationAccess()?.model);
    return scope ? ({ [Op.and]: [where, scope] } as WhereOptions) : where;
  }

  /** The model's row guards for one row; the first refusal stops the write with 422. */
  private async guard(t: Transaction, access: FlowAccess, model: string, op: 'create' | 'update' | 'delete', row: Model, before: Row | null): Promise<void> {
    const get = <T>(token: unknown) => this.moduleRef.get<T>(token as never, { strict: false });
    for (const guard of this.guards.for(model)) {
      const prepared = await preparedFor(guard, access.ctx as never, get, t);
      const reason = await guard.reason({ op, row, before, ctx: access.ctx as never, prepared, can: access.can });
      if (reason) throw refused(reason, guard.code ?? guard.id, model);
    }
  }

  async findOne(t: Transaction, access: FlowAccess, model: string, where: Row, attributes?: string[]): Promise<Row | null> {
    const m = this.model(model, t);
    return (await m.findOne({ where: this.scoped(access, m, where as WhereOptions), ...(attributes ? { attributes } : {}), raw: true, transaction: t })) as Row | null;
  }

  async findAll(t: Transaction, access: FlowAccess, model: string, where: Row, options: { attributes?: string[]; limit?: number } = {}): Promise<Row[]> {
    const m = this.model(model, t);
    const limit = Math.min(options.limit ?? FLOW_ROW_LIMIT, FLOW_ROW_LIMIT);
    return (await m.findAll({ where: this.scoped(access, m, where as WhereOptions), ...(options.attributes ? { attributes: options.attributes } : {}), limit, raw: true, transaction: t })) as unknown as Row[];
  }

  count(t: Transaction, access: FlowAccess, model: string, where: WhereOptions): Promise<number> {
    const m = this.model(model, t);
    return m.count({ where: this.scoped(access, m, where), transaction: t });
  }

  /**
   * One statement for every probe: `SELECT i WHERE EXISTS (SELECT 1 FROM … LIMIT 1) UNION ALL …`.
   * EXISTS stops at the first row (a count reads them all), and N probes are one round trip. Each
   * probe is pinned to the tenant's partition, as a model count is by its hook.
   */
  async existsEach(t: Transaction, access: FlowAccess, probes: Array<{ model: string; where: WhereOptions }>): Promise<boolean[]> {
    if (probes.length === 0) return [];
    const sequelize = sequelizeOf(t);
    const generator = (sequelize.getQueryInterface() as unknown as { queryGenerator: { selectQuery(table: unknown, options: object, model: unknown): string } }).queryGenerator;
    const partition = currentTenant()?.ref.companyId;
    const parts = probes.map((probe, i) => {
      const m = this.model(probe.model, t);
      const pinned = PARTITION.field in m.getAttributes() && !PARTITION.exempt.includes(m.name) && partition ? { [Op.and]: [probe.where, { [PARTITION.field]: partition }] } : probe.where;
      const options = Utils.mapOptionFieldNames({ attributes: [[literal('1'), 'x']], where: this.scoped(access, m, pinned as WhereOptions), limit: 1 } as never, m as never);
      const select = generator.selectQuery(m.getTableName(), options, m).replace(/;\s*$/, '');
      return `SELECT ${i} AS hit WHERE EXISTS (${select})`;
    });
    const rows = await sequelize.query<{ hit: number }>(parts.join(' UNION ALL '), { type: QueryTypes.SELECT, transaction: t });
    const hits = new Set(rows.map((row) => Number(row.hit)));
    return probes.map((_probe, i) => hits.has(i));
  }

  /**
   * Writes: inside an operation the write guard (model hooks) checks the scope and the row guards
   * of every row, as for any write; outside one (a flow run in a test or a job) they are checked here.
   */
  private write<T>(access: FlowAccess, work: () => Promise<T>): Promise<T> {
    return access.system ? asSystem(work) : work();
  }

  private inOperation(): boolean {
    return operationAccess() !== undefined;
  }

  async create(t: Transaction, access: FlowAccess, model: string, values: Row): Promise<Row> {
    const m = this.model(model, t);
    const row = m.build(values as never);
    if (!this.inOperation()) {
      // A new row must fall inside the caller's scope: a branch-limited user cannot create for another branch.
      if (!access.system) this.assertInScope(access, m, row.get({ plain: true }) as Row);
      await this.guard(t, access, model, 'create', row, null);
    }
    return (await this.write(access, () => row.save({ transaction: t }))).get({ plain: true }) as Row;
  }

  async createMany(t: Transaction, access: FlowAccess, model: string, rows: Row[]): Promise<Row[]> {
    if (rows.length > FLOW_ROW_LIMIT) throw new InternalServerErrorException(`Flow: an insert into ${model} of more than ${FLOW_ROW_LIMIT} rows`);
    const m = this.model(model, t);
    if (!this.inOperation()) {
      for (const values of rows) {
        const row = m.build(values as never);
        if (!access.system) this.assertInScope(access, m, row.get({ plain: true }) as Row);
        await this.guard(t, access, model, 'create', row, null);
      }
    }
    const saved = await this.write(access, () => m.bulkCreate(rows as never[], { transaction: t, returning: true }));
    return saved.map((row) => row.get({ plain: true }) as Row);
  }

  async update(t: Transaction, access: FlowAccess, model: string, values: Row, where: Row): Promise<number> {
    const m = this.model(model, t);
    const rows = await this.affected(t, access, m, where);
    if (!this.inOperation()) {
      for (const before of rows) {
        const after = { ...before, ...values };
        // Moving a row out of the caller's scope (to another branch) is refused like creating it there.
        if (!access.system) this.assertInScope(access, m, after);
        await this.guard(t, access, model, 'update', asRow(after), before);
      }
    }
    if (!rows.length) return 0;
    // Instance hooks (write guard, audit, partition) run per row, as for any write through the models.
    const [count] = await this.write(access, () => m.update(values as never, { where: { id: { [Op.in]: rows.map((r) => r.id) } } as WhereOptions, transaction: t, individualHooks: true }));
    return count;
  }

  async destroy(t: Transaction, access: FlowAccess, model: string, where: Row): Promise<number> {
    const m = this.model(model, t);
    const rows = await this.affected(t, access, m, where);
    if (!this.inOperation()) for (const before of rows) await this.guard(t, access, model, 'delete', asRow(before), before);
    if (!rows.length) return 0;
    return this.write(access, () => m.destroy({ where: { id: { [Op.in]: rows.map((r) => r.id) } } as WhereOptions, transaction: t, individualHooks: true }));
  }

  /** The rows a write would touch, inside the scope; more than the cap is refused, never truncated. */
  private async affected(t: Transaction, access: FlowAccess, m: ModelCtor<Model>, where: Row): Promise<Row[]> {
    const rows = (await m.findAll({ where: this.scoped(access, m, where as WhereOptions), limit: FLOW_ROW_LIMIT + 1, raw: true, transaction: t })) as unknown as Row[];
    if (rows.length > FLOW_ROW_LIMIT) throw new InternalServerErrorException(`Flow: a write to ${m.name} would change more than ${FLOW_ROW_LIMIT} rows`);
    return rows;
  }

  /** The scope's own row rule when it has one (`allows`), else its equality / IN conditions, on new values. */
  private assertInScope(access: FlowAccess, m: ModelCtor<Model>, values: Row): void {
    const scope = this.scopes.where(access.ctx as ReqCtx, m);
    if (!scope) return;
    for (const [field, condition] of Object.entries(scope as Record<string, unknown>)) {
      if (!(field in values)) continue;
      const allowed = condition && typeof condition === 'object' ? ((condition as Record<symbol, unknown>)[Op.in] as unknown[] | undefined) : [condition];
      if (allowed && !allowed.map(String).includes(String(values[field]))) throw refused(`Outside your access scope (${field})`, 'out_of_scope', m.name);
    }
  }
}
