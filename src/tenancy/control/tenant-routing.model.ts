import { FRAMEWORK_TABLE } from '../../db/framework-table.js';
import { frameworkPartitionColumn } from '../../tenancy/partition.js';
import { Column, DataType, Model, Table } from 'sequelize-typescript';
import { controlTable } from '../../db/tenant.model.js';

export const ROUTING_STATUSES = ['creating', 'active', 'migrating', 'disabled'] as const;
export type RoutingStatus = (typeof ROUTING_STATUSES)[number];

/** Which database and schema hold a company's rows. One row per company. */
@Table(controlTable('tenant_routing', 'TenantRouting', [{ unique: true, fields: [frameworkPartitionColumn()] }, { fields: ['db_key', 'schema'] }], FRAMEWORK_TABLE))
export class TenantRouting extends Model {
  /** Global company id (from the control plane's companies table). */
  @Column({ type: DataType.INTEGER, allowNull: false })
  companyId: number;

  @Column({ type: DataType.STRING(63), allowNull: false, defaultValue: 'primary' })
  dbKey: string;

  @Column({ type: DataType.STRING(63), allowNull: false })
  schema: string;

  /** Bumped on every placement change. Company tokens carry it; a mismatch forces a new sign-in. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  epoch: number;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'creating' })
  status: RoutingStatus;
}
