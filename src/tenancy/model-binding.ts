import { installWriteGuardHooks } from '../crud/write-guard.js';
import { ForbiddenException, InternalServerErrorException, Logger } from '@nestjs/common';
import { Op, type ModelStatic, type WhereOptions } from 'sequelize';
import type { Model, Sequelize } from 'sequelize-typescript';
import { NAMES } from '../naming.js';
import { currentTenant, requireTenant } from './context.js';
import { PARTITION, partitionColumnOf } from './partition.js';

type AnyModel = ModelStatic<Model> & { options: { schema?: string }; tableName: string };

const logger = new Logger('TenantBinding');

/** A control-plane model: static `platform` schema, never bound to a tenant. */
export function isControlModel(model: { options?: { schema?: string } }): boolean {
  return model.options?.schema === NAMES.controlSchema;
}

export function tenantModelsOf(sequelize: Sequelize): AnyModel[] {
  return (Object.values(sequelize.models) as AnyModel[]).filter((model) => !isControlModel(model));
}

export function controlModelsOf(sequelize: Sequelize): AnyModel[] {
  return (Object.values(sequelize.models) as AnyModel[]).filter((model) => isControlModel(model));
}

function refuse(name: string, property: string) {
  return () => {
    throw new InternalServerErrorException(
      `Refusing to reassign "${name}.${property}". Tenant models are bound once at boot; the connection and schema come from the request.`,
    );
  };
}

const BOUND = new WeakSet<object>();

/**
 * One-place routing of tenant data. Every tenant model gets two CLS getters:
 *  - `sequelize`: the connection of the request's `dbKey` (primary when there is no request);
 *  - `_schema`: the request's schema. Sequelize qualifies every table (`getTableName()` reads it)
 *    including includes and through tables, so no step or list override writes a schema.
 * Outside a tenant context the `_schema` getter throws, so a forgotten context fails closed.
 *
 * Models are initialised once, on the primary connection; other shards register the same model
 * classes without re-initialising them (see `ConnectionRegistry`).
 */
export function bindTenantModels(primary: Sequelize, control: () => Sequelize): void {
  for (const model of Object.values(primary.models) as AnyModel[]) {
    if (BOUND.has(model)) continue;
    BOUND.add(model);
    if (isControlModel(model)) {
      Object.defineProperty(model, 'sequelize', { configurable: true, get: () => control(), set: refuse(model.name, 'sequelize') });
      continue;
    }
    Object.defineProperty(model, 'sequelize', {
      configurable: true,
      get: () => currentTenant()?.sequelize ?? primary,
      set: refuse(model.name, 'sequelize'),
    });
    Object.defineProperty(model, '_schema', {
      configurable: true,
      get: () => requireTenant(model.name).placement.schema,
      set: refuse(model.name, '_schema'),
    });
    if (PARTITION.field in model.getAttributes() && !PARTITION.exempt.includes(model.name)) installPartitionHooks(model);
    installWriteGuardHooks(model as never);
  }
  logger.log(`Bound ${Object.keys(primary.models).length} models`);
}

function installPartitionHooks(model: AnyModel): void {
  const field = PARTITION.field;
  const current = (): number | undefined => {
    const id = currentTenant()?.ref.companyId;
    return id ? id : undefined;
  };
  /** A row of another company is never written from this one: refused, never silently moved. */
  const refuse = (value: unknown, id: number) => {
    throw new ForbiddenException(`${model.name}: a row of company ${String(value)} cannot be written while working for company ${id}`);
  };
  const fill = (instance: Model) => {
    const id = current();
    if (id === undefined) return;
    const value = instance.get(field);
    if (value == null) instance.set(field, id as never);
    else if (Number(value) !== id) refuse(value, id);
  };
  /** A bulk update that would set the partition to another company. */
  const keepOnUpdate = (options: { attributes?: Record<string, unknown> }) => {
    const id = current();
    const value = options.attributes?.[field];
    if (id !== undefined && value !== undefined && value !== null && Number(value) !== id) refuse(value, id);
  };
  const pinOn = (key: string) => (options: { where?: WhereOptions }) => {
    const id = current();
    if (id === undefined) return;
    options.where = options.where ? { [Op.and]: [options.where, { [key]: id }] } : { [key]: id };
  };
  // Find and count map attribute names after the hook; bulk update and destroy have already
  // passed that step, so there the filter must use the column name.
  const pin = pinOn(field);
  const pinColumn = pinOn(partitionColumnOf(model as never));
  model.addHook('beforeValidate', 'framework:partition-fill', fill as never);
  model.addHook('beforeBulkCreate', 'framework:partition-fill-bulk', ((instances: Model[]) => instances.forEach(fill)) as never);
  // The partition filter is also applied here, so a query that forgot it still cannot leave its company.
  model.addHook('beforeFind', 'framework:partition-find', pin as never);
  model.addHook('beforeCount', 'framework:partition-count', pin as never);
  // Joined rows too: a row classic (or anyone) wrote across companies never comes back through a join.
  model.addHook('beforeFindAfterExpandIncludeAll', 'framework:partition-include', ((options: { include?: unknown[] }) => {
    const id = current();
    if (id !== undefined) pinIncludes(options.include, id);
  }) as never);
  model.addHook('beforeBulkUpdate', 'framework:partition-update', pinColumn as never);
  model.addHook('beforeBulkUpdate', 'framework:partition-keep', keepOnUpdate as never);
  // Saves without validation (`validate: false`) skip beforeValidate: check again just before writing.
  model.addHook('beforeCreate', 'framework:partition-create', fill as never);
  model.addHook('beforeUpdate', 'framework:partition-save', fill as never);
  model.addHook('beforeBulkDestroy', 'framework:partition-destroy', pinColumn as never);
  // An upsert by id (bulkCreate updateOnDuplicate, upsert) updates whatever row has that id: never
  // another company's.
  const pkField = () => model.getAttributes()[model.primaryKeyAttribute]?.field ?? model.primaryKeyAttribute;
  const refuseForeignIds = async (rows: Model[], options: { transaction?: unknown }) => {
    const id = current();
    if (id === undefined) return;
    const ids = rows.map((r) => r.get(model.primaryKeyAttribute)).filter((v) => v !== null && v !== undefined);
    if (!ids.length) return;
    const qi = model.sequelize!.getQueryInterface();
    const sql = `SELECT ${qi.quoteIdentifier(pkField())} AS id FROM ${(qi as unknown as { queryGenerator: { quoteTable: (t: unknown) => string } }).queryGenerator.quoteTable(model.getTableName())} WHERE ${qi.quoteIdentifier(pkField())} IN (:ids) AND ${qi.quoteIdentifier(partitionColumnOf(model as never))} <> :company LIMIT 1`;
    const [foreign] = (await model.sequelize!.query(sql, { replacements: { ids, company: id }, type: 'SELECT' as never, transaction: options.transaction as never })) as unknown as Array<{ id: unknown }>;
    if (foreign) throw new ForbiddenException(`${model.name}: row ${String(foreign.id)} belongs to another company and cannot be written while working for company ${id}`);
  };
  model.addHook('beforeBulkCreate', 'framework:partition-upsert-ids', (async (rows: Model[], options: { updateOnDuplicate?: unknown; transaction?: unknown }) => {
    if (options.updateOnDuplicate) await refuseForeignIds(rows, options);
  }) as never);
  model.addHook('beforeUpsert', 'framework:partition-upsert', (async (values: Record<string, unknown>, options: { transaction?: unknown }) => {
    const id = current();
    if (id === undefined) return;
    const value = values[field];
    if (value != null && Number(value) !== id) refuse(value, id);
    if (value == null) values[field] = id;
    await refuseForeignIds([{ get: (k: string) => values[k] } as unknown as Model], options);
  }) as never);
}

type IncludeLike = { model?: AnyModel; where?: WhereOptions; required?: boolean; include?: unknown[]; through?: unknown };

/**
 * The company filter on every joined partitioned model, at any depth. A join keeps its kind: one
 * that was optional (LEFT JOIN) stays optional, since Sequelize would otherwise make a filtered join
 * required.
 */
export function pinIncludes(include: unknown[] | undefined, id: number): void {
  for (const item of include ?? []) {
    if (!item || typeof item !== 'object') continue;
    const inc = item as IncludeLike;
    const target = inc.model;
    if (target && PARTITION.field in target.getAttributes() && !PARTITION.exempt.includes(target.name)) {
      const pin = { [PARTITION.field]: id };
      if (inc.required === undefined) inc.required = !!inc.where;
      inc.where = inc.where ? { [Op.and]: [inc.where, pin] } : pin;
    }
    pinIncludes(inc.include, id);
  }
}
