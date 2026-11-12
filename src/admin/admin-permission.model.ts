import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { Column, DataType, Model, Table } from 'sequelize-typescript';
import { controlTable } from '../db/tenant.model.js';

/** The admin permission catalog (`FrameworkOptions.admin.catalog`), upserted by `AdminCatalogService`. */
@Table(controlTable('admin_permissions', 'AdminPermission', [{ unique: true, fields: ['code'] }], FRAMEWORK_TABLE))
export class AdminPermission extends Model {
  @Column({ type: DataType.STRING(60), allowNull: false })
  resource: string;

  @Column({ type: DataType.STRING(40), allowNull: false })
  action: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  code: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  label: string;

  @Column({ type: DataType.STRING(60), allowNull: false })
  groupName: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  sortOrder: number;
}
