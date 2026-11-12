import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { frameworkPartitionColumn } from '../tenancy/partition.js';
import { Column, DataType, HasMany, Table } from 'sequelize-typescript';
import { TenantModel, tenantTable } from '../db/tenant.model.js';
import type { Rel } from '../db/rel.js';
import { RolePermission } from './role-permission.model.js';

@Table(tenantTable('roles', [{ unique: true, fields: [frameworkPartitionColumn(), 'code'] }], FRAMEWORK_TABLE))
export class Role extends TenantModel {
  @Column({ type: DataType.STRING(80), allowNull: false })
  name: string;

  @Column({ type: DataType.STRING(40), allowNull: false })
  code: string;

  @Column({ type: DataType.STRING(255), allowNull: true })
  description: string | null;

  /** Seeded admin: cannot be deleted and always holds every permission. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  isSystem: boolean;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  status: 'active' | 'inactive';

  /** Bumped whenever the permission set changes. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  aclVersion: number;

  @HasMany(() => RolePermission)
  permissions?: Rel<RolePermission[]>;
}
