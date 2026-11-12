import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { Column, DataType, HasMany, Table } from 'sequelize-typescript';
import type { Rel } from '../db/rel.js';
import { ControlModel, controlTable } from '../db/tenant.model.js';
import { AdminRolePermission } from './admin-role-permission.model.js';

/** A role of platform admins. A system role cannot be deleted and always holds every admin permission. */
@Table(controlTable('admin_roles', 'AdminRole', [{ unique: true, fields: ['code'] }], FRAMEWORK_TABLE))
export class AdminRole extends ControlModel {
  @Column({ type: DataType.STRING(80), allowNull: false })
  name: string;

  @Column({ type: DataType.STRING(40), allowNull: false })
  code: string;

  @Column({ type: DataType.STRING(255), allowNull: true })
  description: string | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  isSystem: boolean;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'active' })
  status: 'active' | 'inactive';

  /** Bumped whenever the permission set changes; admin tokens carry it. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  aclVersion: number;

  @HasMany(() => AdminRolePermission)
  permissions?: Rel<AdminRolePermission[]>;
}
