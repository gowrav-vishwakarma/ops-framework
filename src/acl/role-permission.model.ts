import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { frameworkPartitionColumn } from '../tenancy/partition.js';
import { BelongsTo, Column, DataType, ForeignKey, Table } from 'sequelize-typescript';
import { PartitionedModel, partitionedTable } from '../db/tenant.model.js';
import type { AclScope, Limits } from '../auth/auth-user.js';
import type { Rel } from '../db/rel.js';
import { Permission } from './permission.model.js';
import { Role } from './role.model.js';

@Table(partitionedTable('role_permissions', [{ unique: true, fields: [frameworkPartitionColumn(), 'role_id', 'permission_id'] }], FRAMEWORK_TABLE))
export class RolePermission extends PartitionedModel {
  @ForeignKey(() => Role)
  @Column({ type: DataType.INTEGER, allowNull: false, onDelete: 'CASCADE' })
  roleId: number;

  @ForeignKey(() => Permission)
  @Column({ type: DataType.INTEGER, allowNull: false, onDelete: 'CASCADE' })
  permissionId: number;

  /** Scope id: built-in (`all`, `branch`, `own`) or one the resource offers. */
  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'all' })
  scope: AclScope;

  /** Authority limits, e.g. `{ "amount": 5000 }`. Empty means unlimited. */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  limits: Limits;

  @BelongsTo(() => Role, { onDelete: 'CASCADE' })
  role?: Rel<Role>;

  @BelongsTo(() => Permission, { onDelete: 'CASCADE' })
  permission?: Rel<Permission>;
}
