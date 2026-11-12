import { FRAMEWORK_TABLE } from '../../db/framework-table.js';
import { Column, DataType, Model, Table } from 'sequelize-typescript';
import { controlTable } from '../../db/tenant.model.js';

export const SHARD_STATUSES = ['standby', 'active', 'draining', 'disabled'] as const;
export type ShardStatus = (typeof SHARD_STATUSES)[number];

/** A database that holds tenant schemas. `primary` is the application's own connection. */
@Table(controlTable('tenant_shards', 'TenantShard', [{ unique: true, fields: ['db_key'] }], FRAMEWORK_TABLE))
export class TenantShard extends Model {
  @Column({ type: DataType.STRING(63), allowNull: false })
  dbKey: string;

  @Column({ type: DataType.STRING(10), allowNull: false, defaultValue: 'cloud' })
  type: 'cloud' | 'onprem';

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  status: ShardStatus;

  /** Encrypted (`enc:v1:...`) or a plain `postgres://` URI. Null for `primary`, which uses DATABASE_URI. */
  @Column({ type: DataType.TEXT, allowNull: true })
  connectionUri: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 5000 })
  maxTenants: number;

  /** Pool size for this shard; smaller for on-prem. Null uses the type's default. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  poolMax: number | null;

  /** The connection string never leaves the server; clients see whether one is set. */
  toJSON(): object {
    const { connectionUri, ...rest } = super.toJSON() as Record<string, unknown>;
    return { ...rest, connectionUri: connectionUri ? '(set)' : null };
  }
}
