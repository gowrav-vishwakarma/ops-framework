import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import type { AclScope, Limits } from '../auth/auth-user.js';
import type { Rel } from '../db/rel.js';
import { controlTable } from '../db/tenant.model.js';
import { AdminPermission } from './admin-permission.model.js';
import { AdminRole } from './admin-role.model.js';

@Table(controlTable('admin_role_permissions', 'AdminRolePermission', [{ unique: true, fields: ['role_id', 'permission_id'] }], FRAMEWORK_TABLE))
export class AdminRolePermission extends Model {
  @ForeignKey(() => AdminRole)
  @Column({ type: DataType.INTEGER, allowNull: false, onDelete: 'CASCADE' })
  roleId: number;

  @ForeignKey(() => AdminPermission)
  @Column({ type: DataType.INTEGER, allowNull: false, onDelete: 'CASCADE' })
  permissionId: number;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'all' })
  scope: AclScope;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  limits: Limits;

  @BelongsTo(() => AdminRole, { onDelete: 'CASCADE' })
  role?: Rel<AdminRole>;

  @BelongsTo(() => AdminPermission, { onDelete: 'CASCADE' })
  permission?: Rel<AdminPermission>;
}
