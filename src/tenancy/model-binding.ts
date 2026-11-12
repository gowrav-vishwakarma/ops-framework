import { installWriteGuardHooks } from '../crud/write-guard.js';
import { InternalServerErrorException, Logger } from '@nestjs/common';
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
  const fill = (instance: Model) => {
    const id = current();
    if (id !== undefined && instance.get(field) == null) instance.set(field, id as never);
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
  model.addHook('beforeBulkUpdate', 'framework:partition-update', pinColumn as never);
  model.addHook('beforeBulkDestroy', 'framework:partition-destroy', pinColumn as never);
}
