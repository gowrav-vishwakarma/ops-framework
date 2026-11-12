import type { Transaction, WhereOptions } from 'sequelize';
import { AUDIT_SINK, type AuditSink } from '../features.js';
import type { Model } from 'sequelize-typescript';
import { AclService, type EffectivePermissions } from '../acl/acl.service.js';
import { PermissionMeta } from '../acl/limits.js';
import { BUILT_IN_SCOPES, DEFAULT_SCOPE_IDS, type ScopeDef, type ScopeRef } from '../acl/scopes.js';
import type { Actor, AuthUser, ReqCtx } from '../auth/auth-user.js';
import type { FrameworkOptions } from '../options.js';
import { requireTenant } from '../tenancy/context.js';
import { PARTITION } from '../tenancy/partition.js';
import { tenantTransaction } from '../tenancy/transaction.js';
import type { Sequelize } from 'sequelize-typescript';
import { CrudService } from './crud.service.js';
import type { ListQueryDto } from './list-query.dto.js';
import type { OpPlane } from './op-base.js';
import type { Attrs } from './op-context.js';

export type { Dependent } from './crud.service.js';

/** Fields a request never sets: the row id, the partition and who created or changed the row. */
const SYSTEM_FIELDS = ['id', 'createdById', 'updatedById', 'created_by_id', 'updated_by_id'] as const;

/**
 * CRUD on a tenant's data: every query is pinned to the caller's company, permissions and audit
 * go through the configured `AclSource` and `AuditSink`. See `CrudService`.
 */
export abstract class TenantCrudService<
  M extends Model,
  TCreate extends object,
  TUpdate extends object = Partial<TCreate>,
  TQuery extends ListQueryDto = ListQueryDto,
> extends CrudService<M, TCreate, TUpdate, TQuery, AuthUser> {
  protected readonly defaultScopes: readonly ScopeRef[] = DEFAULT_SCOPE_IDS;
  protected readonly metaToken = PermissionMeta;

  /** The connection of the request's tenant (set by the guard); services never inject one. */
  protected get sequelize(): Sequelize {
    return requireTenant('a database query').sequelize;
  }

  protected planeTx<T>(work: (t: Transaction) => Promise<T>): Promise<T> {
    return tenantTransaction(work);
  }

  protected pin(ctx: ReqCtx<AuthUser>): WhereOptions {
    return { [PARTITION.field]: ctx.user.companyId } as WhereOptions;
  }

  /** The partition, and who created and changed the row when the model has those columns. */
  protected stamps(ctx: ReqCtx<AuthUser>): Attrs {
    return {
      [PARTITION.field]: ctx.user.companyId,
      ...(this.hasAttribute('createdById') ? { createdById: ctx.user.id } : {}),
      ...(this.hasAttribute('updatedById') ? { updatedById: ctx.user.id } : {}),
    };
  }

  protected updateStamps(ctx: ReqCtx<AuthUser>): Attrs {
    return this.hasAttribute('updatedById') ? { updatedById: ctx.user.id } : {};
  }

  /** The DTO without the system fields (id, partition, created/updated by): a request cannot move a row to another company. */
  protected withoutSystemFields(dto: object): Attrs {
    const raw = { ...dto } as Attrs;
    for (const field of [...SYSTEM_FIELDS, PARTITION.field, PARTITION.column]) delete raw[field];
    return raw;
  }

  /** Attributes to store on create: the DTO without system fields. Override to map it. */
  protected override async toCreate(_ctx: ReqCtx<AuthUser>, dto: TCreate, _t: Transaction): Promise<Attrs> {
    return this.withoutSystemFields(dto);
  }

  /** Attributes to set on update: the DTO without system fields. Override to map it. */
  protected override async toUpdate(_ctx: ReqCtx<AuthUser>, dto: TUpdate, _row: M, _t: Transaction): Promise<Attrs> {
    return this.withoutSystemFields(dto);
  }

  /** A feature provider, or null when the project did not configure it. */
  private optional<T>(token: symbol): T | null {
    try {
      return this.moduleRef.get<T>(token as never, { strict: false });
    } catch {
      return null;
    }
  }

  private required<T>(token: symbol, feature: string): T {
    const found = this.optional<T>(token);
    if (!found) throw new Error(`${this.label}: needs features.${feature} in FrameworkModule.forRootAsync`);
    return found;
  }

  effective(ctx: ReqCtx<AuthUser>): Promise<EffectivePermissions> {
    return this.moduleRef.get(AclService, { strict: false }).effective(ctx.user);
  }

  protected registeredScopes(options: FrameworkOptions): ScopeDef<Model, Actor>[] {
    return [...BUILT_IN_SCOPES, ...(options.scopes ?? [])] as ScopeDef<Model, Actor>[];
  }

  protected recordEvent(t: Transaction, ctx: ReqCtx<AuthUser>, entityId: number, event: string, data: Attrs | null): Promise<void> {
    return this.required<AuditSink>(AUDIT_SINK, 'audit').record(t, ctx, { entityType: this.model.name, entityId, event, data });
  }

  protected historyRows(ctx: ReqCtx<AuthUser>, id: number): Promise<unknown[]> {
    return this.required<AuditSink>(AUDIT_SINK, 'audit').history(ctx, this.model.name, id);
  }

  protected opPlane(): OpPlane<AuthUser> {
    return {
      separate: (work) => tenantTransaction(work),
      can: async (ctx, code) => (await this.effective(ctx)).get(code)?.scope ?? null,
    };
  }
}

