import { Injectable } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import type { AdminUser, ReqCtx } from '../auth/auth-user.js';
import type { AuditEntry, ControlAuditSink } from '../features.js';
import { runWithoutTenant } from '../tenancy/context.js';
import { ControlPlane } from '../tenancy/tenant-db.js';
import { ControlEvent } from './control-event.model.js';

/** `features.admin: 'tables'`: the control plane's audit in the framework's `entity_events` (control schema). */
@Injectable()
export class TableControlAuditSink implements ControlAuditSink {
  constructor(private readonly control: ControlPlane) {}

  async record(t: Transaction, ctx: ReqCtx<AdminUser>, entry: AuditEntry): Promise<void> {
    await ControlEvent.create(
      { entityType: entry.entityType, entityId: entry.entityId, event: entry.event, actorId: ctx.user.id, actorName: ctx.user.name, actorKind: ctx.user.kind, data: entry.data } as never,
      { transaction: t },
    );
  }

  async history(_ctx: ReqCtx<AdminUser>, entityType: string, entityId: number, limit = 200): Promise<unknown[]> {
    const rows = await runWithoutTenant(() =>
      this.control.tx((t) => ControlEvent.findAll({ where: { entityType, entityId }, order: [['id', 'DESC']], limit, transaction: t })),
    );
    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      data: row.data,
      createdAt: row.get('createdAt'),
      userId: row.actorId,
      userName: row.actorName,
      userKind: row.actorKind,
    }));
  }
}
