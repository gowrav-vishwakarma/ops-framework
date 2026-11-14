import { BadRequestException } from '@nestjs/common';
import type { Transaction, WhereOptions } from 'sequelize';
import type { Model } from 'sequelize-typescript';
import type { EffectivePermissions } from '../acl/acl.service.js';
import { allScope, type ScopeDef, type ScopeRef } from '../acl/scopes.js';
import { AdminAclService, AdminPermissionMeta } from '../admin/admin-acl.service.js';
import type { Actor, AdminUser, ReqCtx } from '../auth/auth-user.js';
import { CONTROL_AUDIT_SINK, type ControlAuditSink } from '../features.js';
import type { FrameworkOptions } from '../options.js';
import { runWithoutTenant } from '../tenancy/context.js';
import { ControlPlane } from '../tenancy/tenant-db.js';
import { CrudService } from './crud.service.js';
import type { ListQueryDto } from './list-query.dto.js';
import type { OpPlane } from './op-base.js';
import type { Attrs } from './op-context.js';

/** Rows the admin created. */
export const createdScope: ScopeDef<Model, Actor> = {
  id: 'own',
  label: 'Own records',
  where: (ctx, model) => ('createdById' in model.getAttributes() ? ({ createdById: ctx.user.id } as WhereOptions) : null),
  allows: (ctx, row) => row.get('createdById') === undefined || row.get('createdById') === ctx.user.id,
};

/**
 * CRUD on the control plane, for admin panels: the same steps, actions, list views, limits and
 * history as a tenant entity, with the admin's permissions (`AdminAclService`), audit through the control
 * audit sink (`features.admin`), and no company pin. Scopes: `all`, `own` (created by the admin) and those
 * in `FrameworkOptions.admin.scopes` (a partner's companies...). See `CrudService`.
 */
export abstract class ControlCrudService<
  M extends Model,
  TCreate extends object,
  TUpdate extends object = Partial<TCreate>,
  TQuery extends ListQueryDto = ListQueryDto,
> extends CrudService<M, TCreate, TUpdate, TQuery, AdminUser> {
  protected readonly defaultScopes: readonly ScopeRef[] = ['all'];
  protected readonly metaToken = AdminPermissionMeta;

  private get control(): ControlPlane {
    return this.moduleRef.get(ControlPlane, { strict: false });
  }

  protected planeTx<T>(work: (t: Transaction) => Promise<T>): Promise<T> {
    return runWithoutTenant(() => this.control.tx(work));
  }

  protected pin(): WhereOptions | null {
    return null;
  }

  protected stamps(ctx: ReqCtx<AdminUser>): Attrs {
    return this.hasAttribute('createdById') ? { createdById: ctx.user.id, updatedById: ctx.user.id } : {};
  }

  protected updateStamps(ctx: ReqCtx<AdminUser>): Attrs {
    return this.hasAttribute('updatedById') ? { updatedById: ctx.user.id } : {};
  }

  effective(ctx: ReqCtx<AdminUser>): Promise<EffectivePermissions> {
    return this.moduleRef.get(AdminAclService, { strict: false }).effective(ctx.user);
  }

  protected registeredScopes(options: FrameworkOptions): ScopeDef<Model, Actor>[] {
    return [allScope, createdScope, ...((options.admin?.scopes ?? []) as ScopeDef<Model, Actor>[])];
  }

  private get audit(): ControlAuditSink {
    return this.moduleRef.get(CONTROL_AUDIT_SINK, { strict: false });
  }

  protected async recordEvent(t: Transaction, ctx: ReqCtx<AdminUser>, entityId: number, event: string, data: Attrs | null): Promise<void> {
    await this.audit.record(t, ctx, { entityType: this.model.name, entityId, event, data });
  }

  protected historyRows(ctx: ReqCtx<AdminUser>, id: number): Promise<unknown[]> {
    return this.audit.history(ctx, this.model.name, id);
  }

  protected codeOptions(): undefined {
    return undefined;
  }

  protected opPlane(): OpPlane<AdminUser> {
    return {
      separate: (work) => this.planeTx(work),
      can: async (ctx, code) => (await this.effective(ctx)).get(code)?.scope ?? null,
    };
  }
}
