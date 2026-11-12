import { Injectable } from '@nestjs/common';
import { QueryTypes, type Transaction } from 'sequelize';
import type { ReqCtx } from '../auth/auth-user.js';
import type { AuditEntry, AuditSink } from '../features.js';
import { NAMES } from '../naming.js';
import { quoteIdent } from '../tenancy/context.js';
import { sequelizeOf } from '../tenancy/guards.js';
import { frameworkPartitionColumn } from '../tenancy/partition.js';
import { tenantTransaction } from '../tenancy/transaction.js';
import { EntityEvent } from './entity-event.model.js';

/** `features.audit: 'tables'`: one `entity_events` row per change, in the change's transaction. */
@Injectable()
export class TableAuditSink implements AuditSink {
  async record(t: Transaction, ctx: ReqCtx, entry: AuditEntry): Promise<void> {
    await EntityEvent.create(
      { companyId: ctx.user.companyId, entityType: entry.entityType, entityId: entry.entityId, event: entry.event, userId: ctx.user.id, data: entry.data } as never,
      { transaction: t },
    );
  }

  history(ctx: ReqCtx, entityType: string, entityId: number, limit = 200): Promise<unknown[]> {
    return tenantTransaction((t) =>
      sequelizeOf(t).query(
        `SELECT e.id, e.event, e.data, e.created_at AS "createdAt", e.user_id AS "userId", u.name AS "userName"
           FROM entity_events e LEFT JOIN ${quoteIdent(NAMES.userTable)} u ON u.id = e.user_id
          WHERE e.${quoteIdent(frameworkPartitionColumn())} = :company AND e.entity_type = :type AND e.entity_id = :id
          ORDER BY e.id DESC LIMIT :limit`,
        { replacements: { company: ctx.user.companyId, type: entityType, id: entityId, limit }, type: QueryTypes.SELECT, transaction: t },
      ),
    );
  }
}
