import { FRAMEWORK_TABLE } from '../db/framework-table.js';
import { frameworkPartitionColumn } from '../tenancy/partition.js';
import { Table } from 'sequelize-typescript';
import { Int, Json, Str } from '../db/columns.js';
import { Polymorphic, SoftRef } from '../db/refs.js';
import { TenantModel, tenantTable } from '../db/tenant.model.js';
import { NAMES } from '../naming.js';

/** Who did what to which row: create, update (with changed fields), delete and every named action. */
@Polymorphic({ typeColumn: 'entityType', idColumn: 'entityId' })
@Table(tenantTable('entity_events', [{ fields: [frameworkPartitionColumn(), 'entity_type', 'entity_id', 'created_at'] }], FRAMEWORK_TABLE))
export class EntityEvent extends TenantModel {
  @Str(40)
  entityType: string;

  @Int()
  entityId: number;

  /** `create`, `update`, `delete` or `action:<name>`. */
  @Str(60)
  event: string;

  @SoftRef(NAMES.userTable, { zeroIsSystem: true })
  @Int({ nullable: true })
  userId: number | null;

  /** Changed fields as `{ field: [before, after] }`, or the action input. */
  @Json()
  data: Record<string, unknown> | null;
}
