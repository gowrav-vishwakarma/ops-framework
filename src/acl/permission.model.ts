import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { Column, DataType, Model, Table } from 'sequelize-typescript';
import { referenceTable } from '../db/refs.js';

/**
 * The permission catalog, upserted from the code on boot. A reference table: every tenant schema
 * holds the same rows (matched by `code` when a company moves), and it is not partitioned.
 */
@Table(referenceTable('permissions', 'code', [{ unique: true, fields: ['resource', 'action'] }], FRAMEWORK_TABLE))
export class Permission extends Model {
  @Column({ type: DataType.STRING(60), allowNull: false })
  resource: string;

  @Column({ type: DataType.STRING(40), allowNull: false })
  action: string;

  /** `resource.action`, the form the frontend and JWT-side checks use. */
  @Column({ type: DataType.STRING(120), allowNull: false, unique: true })
  code: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  label: string;

  /** Menu group for the permission matrix, such as Operations or Finance. */
  @Column({ type: DataType.STRING(60), allowNull: false })
  groupName: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  sortOrder: number;
}
