import { Column, DataType, Model, type TableOptions } from 'sequelize-typescript';
import type { ModelIndexesOptions } from 'sequelize';
import { NAMES } from '../naming.js';
import { frameworkPartitionColumn, PARTITION } from '../tenancy/partition.js';
import { SoftRef } from './refs.js';

/** Schema of the control plane (companies, identities, routing). Never holds tenant rows. Set with `defineNames`. */
export const controlSchema = (): string => NAMES.controlSchema;

/**
 * Rows that belong to one tenant: carry the partition column (`companyId`), which references the
 * schema-local mirror table so the foreign key moves with the company. Join tables extend this.
 */
export abstract class PartitionedModel<TAttributes extends object = any, TCreation extends object = TAttributes> extends Model<
  TAttributes,
  TCreation
> {
  /** The partition column. Filled from the tenant context on create when left out. */
  companyId: number;
}

// The partition column is declared from the config, so an app can name it differently. It must be
// added before any subclass is declared: sequelize-typescript copies a parent's attributes at that moment.
Column({
  type: DataType.INTEGER,
  allowNull: false,
  references: { model: PARTITION.mirror, key: 'id' },
  onDelete: 'CASCADE',
})(PartitionedModel.prototype, PARTITION.field);

/** Columns every tenant row carries. Subclasses add their own attributes. */
export abstract class TenantModel<TAttributes extends object = any, TCreation extends object = TAttributes> extends PartitionedModel<
  TAttributes,
  TCreation
> {
  // No database constraint: `systemCtx` writes user 0 ("System"), which is not a row. A move remaps them.
  @SoftRef(NAMES.userTable, { zeroIsSystem: true })
  @Column({ type: DataType.INTEGER, allowNull: true })
  createdById: number | null;

  @SoftRef(NAMES.userTable, { zeroIsSystem: true })
  @Column({ type: DataType.INTEGER, allowNull: true })
  updatedById: number | null;
}

export interface TableNaming {
  /** snake_case columns. Default `NAMES.underscored` (the project's convention); the framework's own tables pass true. */
  underscored?: boolean;
}

/** Partition column of a table with the given naming. */
function partitionIndexColumn(underscored: boolean): string {
  return underscored ? frameworkPartitionColumn() : PARTITION.column;
}

/** Table options for a partitioned table. Index fields are column names. */
export function tenantTable(tableName: string, indexes: ModelIndexesOptions[] = [], options: { softDelete?: boolean } & TableNaming = {}): TableOptions {
  const underscored = options.underscored ?? NAMES.underscored;
  return {
    tableName,
    underscored,
    timestamps: true,
    // Soft delete: `destroy()` sets the deleted-at column, finds skip those rows, `restore()` brings one back.
    ...(options.softDelete ? { paranoid: true } : {}),
    indexes: [{ fields: [partitionIndexColumn(underscored)] }, ...indexes],
  };
}

/** Same as `tenantTable`; the name says the table is a child or join table. */
export const partitionedTable = tenantTable;

/** Table options for a control-plane table (static `platform` schema, not bound to a tenant). */
export function controlTable(tableName: string, modelName: string, indexes: ModelIndexesOptions[] = [], options: TableNaming = {}): TableOptions {
  return { tableName, modelName, schema: NAMES.controlSchema, underscored: options.underscored ?? NAMES.underscored, timestamps: true, indexes };
}

/** `DECIMAL(14,2)` money column. Postgres returns these as strings. */
export const MONEY = DataType.DECIMAL(14, 2);
/** Weights, km and litres. */
export const QTY = DataType.DECIMAL(14, 3);

/** FK column options referencing another table. */
export function ref(table: string, onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' = 'RESTRICT') {
  return { references: { model: table, key: 'id' }, onDelete };
}

/**
 * A control-plane row an admin edits through `ControlCrudService`: who created and last changed it
 * (admin ids; no constraint, the admin table is the project's).
 */
export abstract class ControlModel<TAttributes extends object = any, TCreation extends object = TAttributes> extends Model<TAttributes, TCreation> {
  @Column({ type: DataType.INTEGER, allowNull: true })
  createdById: number | null;

  @Column({ type: DataType.INTEGER, allowNull: true })
  updatedById: number | null;
}
