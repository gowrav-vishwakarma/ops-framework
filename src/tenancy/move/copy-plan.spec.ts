import { BelongsTo, Column, DataType, ForeignKey, Model, PrimaryKey, Sequelize, Table } from 'sequelize-typescript';
import { describe, expect, it } from 'vitest';
import { PartitionedModel, tenantTable } from '../../db/tenant.model.js';
import { buildCopyPlan, idKindOf } from './copy-plan.js';

@Table({ tableName: 'Companies' })
class Company extends Model {}

@Table(tenantTable('threads'))
class Thread extends PartitionedModel {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: DataType.UUIDV4 })
  declare id: string;

  @ForeignKey(() => Thread)
  @Column({ type: DataType.UUID, allowNull: true })
  parentId: string | null;

  @BelongsTo(() => Thread, 'parentId')
  parent?: Thread;
}

@Table(tenantTable('messages'))
class Message extends PartitionedModel {
  @ForeignKey(() => Thread)
  @Column({ type: DataType.UUID, allowNull: false })
  threadId: string;

  @BelongsTo(() => Thread, 'threadId')
  thread?: Thread;

  @ForeignKey(() => Message)
  @Column({ type: DataType.INTEGER, allowNull: true })
  replyToId: number | null;

  @BelongsTo(() => Message, 'replyToId')
  replyTo?: Message;
}

describe('company move plan: tables with UUID ids', () => {
  new Sequelize({ dialect: 'postgres', logging: false }).addModels([Company, Thread, Message]);
  const plan = buildCopyPlan([Company, Thread, Message] as never);
  const step = (table: string) => plan.find((s) => s.table === table)!;

  it('keeps UUID ids (no id map) and renumbers auto-increment ones', () => {
    expect(idKindOf(Thread as never)).toBe('natural');
    expect(idKindOf(Message as never)).toBe('serial');
    expect(step('threads')).toMatchObject({ kind: 'partitioned', idKind: 'natural', idType: 'uuid', hasId: true, selfColumns: ['parentId'] });
    expect(step('messages')).toMatchObject({ idKind: 'serial', selfColumns: ['replyToId'] });
  });

  it('does not translate references to kept ids, and still translates serial ones', () => {
    expect(step('messages').inline.map((r) => r.column)).not.toContain('threadId');
    expect(step('messages').later.map((r) => r.column)).not.toContain('threadId');
    expect(plan.findIndex((s) => s.table === 'threads')).toBeLessThan(plan.findIndex((s) => s.table === 'messages'));
  });
});
