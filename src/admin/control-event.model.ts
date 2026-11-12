import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { Column, DataType, Model, Table } from 'sequelize-typescript';
import { controlTable } from '../db/tenant.model.js';

/**
 * The audit trail of the control plane: every create, edit, delete and action an admin makes, in the
 * same transaction. The actor's name is kept on the row (the admin table is the project's).
 */
@Table(controlTable('entity_events', 'ControlEvent', [{ fields: ['entity_type', 'entity_id'] }], FRAMEWORK_TABLE))
export class ControlEvent extends Model {
  @Column({ type: DataType.STRING(80), allowNull: false })
  entityType: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  entityId: number;

  @Column({ type: DataType.STRING(80), allowNull: false })
  event: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  actorId: number;

  @Column({ type: DataType.STRING(120), allowNull: false })
  actorName: string;

  @Column({ type: DataType.STRING(40), allowNull: false })
  actorKind: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  data: Record<string, unknown> | null;
}
