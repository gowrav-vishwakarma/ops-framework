import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { frameworkPartitionColumn } from '../tenancy/partition.js';
import { Column, DataType, Model, Table } from 'sequelize-typescript';
import { PartitionedModel, controlTable, tenantTable } from '../db/tenant.model.js';

/**
 * What a handler already did: a command's idempotency key with its result, or an event a
 * subscriber already handled. Written in the handler's own transaction, so it exists exactly when
 * the handler's work committed; a retry finds it and returns the stored result instead.
 */
@Table(controlTable('framework_inbox', 'ControlInbox', [{ unique: true, fields: ['handler', 'key'] }, { fields: ['created_at'] }], FRAMEWORK_TABLE))
export class ControlInbox extends Model {
  /** `contract.call` or `SubscriberClass.method`. */
  @Column({ type: DataType.STRING(160), allowNull: false })
  handler: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  key: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  result: unknown;
}

@Table(tenantTable('framework_inbox', [{ unique: true, fields: [frameworkPartitionColumn(), 'handler', 'key'] }, { fields: ['created_at'] }], FRAMEWORK_TABLE))
export class TenantInbox extends PartitionedModel {
  @Column({ type: DataType.STRING(160), allowNull: false })
  handler: string;

  @Column({ type: DataType.STRING(200), allowNull: false })
  key: string;

  @Column({ type: DataType.JSONB, allowNull: true })
  result: unknown;
}
