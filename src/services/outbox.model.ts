import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { Column, DataType, Model, Table } from 'sequelize-typescript';
import { PartitionedModel, controlTable, tenantTable } from '../db/tenant.model.js';

/**
 * Events waiting to be published, written in the same transaction as the change they describe, so
 * an event exists exactly when its change committed. Published right after commit; a sweeper
 * publishes whatever a crashed process left behind. One table on the control plane and one in each
 * tenant schema (tenant rows carry the company and move with it).
 */

@Table(controlTable('framework_outbox', 'ControlOutbox', [{ fields: ['published_at', 'id'] }], FRAMEWORK_TABLE))
export class ControlOutbox extends Model {
  @Column({ type: DataType.UUID, allowNull: false })
  eventId: string;

  @Column({ type: DataType.STRING(80), allowNull: false })
  contract: string;

  @Column({ type: DataType.STRING(80), allowNull: false })
  event: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  payload: unknown;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  caller: Record<string, unknown>;

  @Column({ type: DataType.DATE, allowNull: true })
  publishedAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  attempts: number;

  /** The company the event is about, if any. */
  @Column({ type: DataType.INTEGER, allowNull: true })
  companyId: number | null;
}

@Table(tenantTable('framework_outbox', [{ fields: ['published_at', 'id'] }], FRAMEWORK_TABLE))
export class TenantOutbox extends PartitionedModel {
  @Column({ type: DataType.UUID, allowNull: false })
  eventId: string;

  @Column({ type: DataType.STRING(80), allowNull: false })
  contract: string;

  @Column({ type: DataType.STRING(80), allowNull: false })
  event: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  payload: unknown;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  caller: Record<string, unknown>;

  @Column({ type: DataType.DATE, allowNull: true })
  publishedAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  attempts: number;
}
