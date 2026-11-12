import type { Type } from '@nestjs/common';
import type { Request } from 'express';
import type { Transaction } from 'sequelize';
import type { EffectivePermissions } from './acl/acl.service.js';
import type { AuthUser, ReqCtx } from './auth/auth-user.js';
import type { TenantRef } from './tenancy/context.js';

/**
 * Where a project's data and rules live. The framework owns no table unless a feature says
 * `'tables'`: a project with its own schema (Ankpal) plugs its classes in, a project that lets the
 * framework own the schema (TMS) picks `'tables'`.
 */

/** The permissions a signed-in user holds (`<resource>.<action>` -> scope and limits). */
export interface AclSource {
  load(user: AuthUser, t?: Transaction): Promise<EffectivePermissions>;
}
export const ACL_SOURCE = Symbol('ACL_SOURCE');

/** Where every create, edit, delete and action is written, and where a record's history is read. */
export interface AuditSink {
  record(t: Transaction, ctx: ReqCtx, entry: AuditEntry): Promise<void>;
  /** Newest first, at most `limit` (default 200). */
  history(ctx: ReqCtx, entityType: string, entityId: number, limit?: number): Promise<unknown[]>;
}
export interface AuditEntry {
  /** Model name. */
  entityType: string;
  entityId: number;
  /** `create`, `update`, `delete`, `restore` or `action:<name>`. */
  event: string;
  /** Snapshot (create), `{ field: [before, after] }` (update), or the action input. */
  data: Record<string, unknown> | null;
}
export const AUDIT_SINK = Symbol('AUDIT_SINK');

/** Where a tenant lives. */
export interface TenantRoute {
  companyId: number;
  /** The project's string key for the tenant (Ankpal: the schema name in the token). */
  tenantKey?: string | null;
  dbKey: string;
  schema: string;
  status: 'creating' | 'active' | 'migrating' | 'disabled';
  /** Bumped when the route changes; 0 when the project does not track it. */
  epoch: number;
}

/** A database tenants live in. */
export interface ShardInfo {
  dbKey: string;
  /** Plain connection URI (decrypted). */
  uri: string;
  status: 'standby' | 'active' | 'draining' | 'disabled';
  type: 'cloud' | 'onprem';
  poolMax?: number | null;
}

/** Routes and shards, read for every request (cached by `PlacementResolver`). */
export interface PlacementStore {
  route(ref: TenantRef): Promise<TenantRoute | null>;
  activeRoutes(): Promise<TenantRoute[]>;
  shard(dbKey: string): Promise<ShardInfo | null>;
}
export const PLACEMENT_STORE = Symbol('PLACEMENT_STORE');

/**
 * Checks a company token inside its tenant: runs in `TenantContextGuard` once the tenant context is
 * set (so it can read tenant tables), before permissions. Revocation, stored token comparison,
 * account and branch access. Throw `UnauthorizedException` to refuse. May return fields merged into
 * the user (`branchIds` loaded from the database...).
 */
export interface TokenValidator {
  validate(claims: Record<string, unknown>, user: AuthUser, request: Request): Promise<Partial<AuthUser> | void>;
}
export const TOKEN_VALIDATOR = Symbol('TOKEN_VALIDATOR');

/** `'tables'`: the framework's own tables and services. A class: the project's implementation. */
export type FeatureImpl<T> = 'tables' | Type<T>;

export interface FrameworkFeatures {
  /** Tenant permissions. Required for tenant routes that use `@RequirePermission`. */
  acl?: FeatureImpl<AclSource>;
  /** Audit of every write. Required by `TenantCrudService`. */
  audit?: FeatureImpl<AuditSink>;
  /** Routes and shards, for `tenancy.placement.strategy: 'routed'`. */
  placement?: FeatureImpl<PlacementStore>;
  /** Extra checks of every company token. */
  tokenValidator?: Type<TokenValidator>;
  /** Service contracts, outbox, inbox and `/_ops/calls` (platform and tenant as separate services). */
  services?: boolean;
  /** Admin roles, permissions and audit on the control plane (`FrameworkOptions.admin`). */
  admin?: boolean;
  /**
   * `owned`: the framework builds and migrates schemas (sync in dev, migration runner, provisioning,
   * company moves); needs `placement: 'tables'` when routed. `external` (default): another system
   * owns the schema; the framework only checks each schema has the models' tables and columns.
   */
  schema?: 'owned' | 'external';
}

/** Features after defaults. */
export type ResolvedFeatures = FrameworkFeatures & { schema: 'owned' | 'external' };

export function resolveFeatures(features: FrameworkFeatures = {}): ResolvedFeatures {
  const resolved: ResolvedFeatures = { ...features, schema: features.schema ?? 'external' };
  if (resolved.schema === 'owned' && resolved.placement && resolved.placement !== 'tables') {
    throw new Error("features.schema 'owned' builds and moves tenant places through the framework's routing tables: set features.placement to 'tables'");
  }
  return resolved;
}

export const FRAMEWORK_FEATURES = Symbol('FRAMEWORK_FEATURES');
