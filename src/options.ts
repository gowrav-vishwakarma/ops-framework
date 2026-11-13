import type { Model } from 'sequelize-typescript';
import type { AdminUser, AuthUser } from './auth/auth-user.js';
import type { PermissionEntry } from './acl/catalog-types.js';
import type { ScopeDef } from './acl/scopes.js';
import type { TenantRef } from './tenancy/context.js';
import type { PartitionConfig } from './tenancy/partition.js';
import type { LoggingOptions } from './logging/request-log.js';

export const FRAMEWORK_OPTIONS = Symbol('FRAMEWORK_OPTIONS');

export type PlacementStrategy =
  /** Every tenant at one fixed place. */
  | { strategy: 'single'; dbKey?: string; schema: string }
  /** Schema `${prefix}${companyId}` on one database. */
  | { strategy: 'schemaPerTenant'; dbKey?: string; prefix: string }
  /** Looked up in the control plane's `tenant_routing` (cached). */
  | { strategy: 'routed'; cacheMs?: number };

/** Everything the framework needs from the app. */
export interface FrameworkOptions {
  /** Every permission: resource, action, label, group, and the scopes the resource offers. */
  catalog: readonly PermissionEntry[];
  /**
   * How permission codes are spelled. The framework asks for `list`, `view`, `create`, `update`,
   * `delete`, `restore` and action names; `actionNames` renames them (Ankpal: `{ list: 'page', update: 'edit' }`)
   * and `code` joins resource and action (default `${resource}.${action}`).
   */
  acl?: {
    actionNames?: Record<string, string>;
    code?: (resource: string, action: string) => string;
    /**
     * `features.acl: 'tables'`: a column of `NAMES.userTable` holding the user's status (`'status'`).
     * When set, a user whose row there is not `'active'` is refused (403) when permissions load.
     * Cached with the permissions: call `AclService.forgetUser` after changing it.
     */
    userStatusColumn?: string;
  };
  /** Request, SQL and step logging (see `LoggingOptions`). Default: one start and one finish line per request. */
  logging?: LoggingOptions;
  /** Scope providers beyond the built-in `all`, `branch` and `own`. */
  scopes?: ScopeDef[];
  tenancy: {
    /** Defaults to `companyId` / `company_id` / `companies`. Must be set before models are imported. */
    partition?: Partial<PartitionConfig>;
    /** The tenant of a signed-in user. Defaults to `{ companyId: user.companyId, tenantKey: user.tenantKey }`. */
    resolve?: (user: AuthUser) => TenantRef;
    /**
     * Headers a client may send, checked against the token (never used to pick the tenant): a
     * mismatch is 403. Default `{ 'x-company-id': 'companyId', 'x-tenant-id': 'tenantKey' }`;
     * `tenantKey` falls back to the company id when the tenant has no key.
     */
    headers?: Record<string, 'companyId' | 'tenantKey'>;
    placement: PlacementStrategy;
    /** Schema used when a shard has no routing row of its own. */
    sharedSchema?: string;
    /**
     * Raw SQL in a tenant context must name the company for every partitioned table it uses
     * (`tenancy/company-sql.ts`): `error` refuses a statement that does not (set it in tests and
     * scenario runs), `warn` logs it, `off` (default: no cost per query in production) skips the check.
     * Model calls are always filtered by the partition hooks.
     */
    companySql?: 'off' | 'warn' | 'error';
  };
  auth: {
    /** Maps verified access-token claims to the signed-in user. */
    userClaims: (claims: Record<string, unknown>) => AuthUser;
    /** Signs and verifies every token. Every deployment of the app shares it. */
    jwtSecret: string;
    /** Also checked when verifying (and set when signing with `SessionTokens`). */
    issuer?: string;
    audience?: string;
    /**
     * What a verified token is for. Default: its `typ` claim, else `access` when it carries the
     * partition field (a company token) and `login` otherwise.
     */
    tokenKind?: (claims: Record<string, unknown>) => 'access' | 'login' | 'admin' | null;
    /** `required`: the token's routing epoch must equal the route's (moves invalidate tokens). Default `off`. */
    epoch?: 'required' | 'off';
    /** Company token lifetime. Default `15m`. */
    accessTtl?: string;
    /** Lifetime of the token between password and company choice. Default `10m`. */
    loginTtl?: string;
    /** Default 30. */
    refreshTtlDays?: number;
  };
  /** Encrypts shard connection URIs stored in the framework's `tenant_shards` (`features.placement: 'tables'`). */
  secretKey?: string;
  /**
   * `alter` applies the models to the platform and every routed tenant schema at boot: local
   * development only (refused when NODE_ENV is production). Otherwise schemas change through
   * migrations (`MigrationRunner`, `npm run migrate`).
   */
  dbSync?: 'none' | 'alter';
  /**
   * Model id columns that are neither a foreign key nor declared (`@SoftRef`, `@NotARef`): `error`
   * fails building a schema (company moves rely on the declarations), `warn` logs, `off` skips.
   * Default `warn`.
   */
  refs?: { undeclared?: 'error' | 'warn' | 'off' };
  /**
   * When a tenant schema lacks a table or column the models declare: `block` refuses its requests
   * (503), `warn` logs the gaps once per schema, `off` skips the check. Default: `block` when the
   * framework owns the schema, `warn` when another system migrates it (its drift is reported, not
   * turned into an outage).
   */
  schemaParity?: 'block' | 'warn' | 'off';
  /** Folders of migration files: `control` runs once on the control plane, `tenant` in every tenant schema. */
  migrations?: { control?: string; tenant?: string };
  /** A separate database for the control plane. Unset: the primary connection, schema `platform`. */
  controlDbUri?: string;
  /** Pool sizes of non-primary shards. */
  shardPool?: { cloud?: number; onprem?: number };
  /** A non-primary shard pool idle this long is closed (default 10 minutes); reopened on next use. */
  shardIdleMs?: number;
  /**
   * Redis shared by every process of the deployment: the cluster bus (cache invalidation) and
   * service events. Unset: one process only (local bus, in-process events).
   */
  redis?: { url: string };
  /**
   * The admin side (control plane): who platform admins are and what they may do. Without it no
   * admin token is accepted. The admin table and sign-in are the project's; the framework keeps the
   * admin roles, permissions and audit.
   */
  admin?: {
    /** Every admin permission, like `catalog` for tenants. */
    catalog: readonly PermissionEntry[];
    /** Admin scopes beyond `all` and `own` (a partner's companies...). */
    scopes?: ScopeDef<Model, AdminUser>[];
    /** Maps verified admin-token claims to the admin. */
    userClaims: (claims: Record<string, unknown>) => AdminUser;
    /** Admin token lifetime. Default `8h`. */
    tokenTtl?: string;
  };
  /** Service contracts between deployments (see `services/`). */
  services?: {
    /**
     * Base URL (with the global prefix) of the deployment that answers each contract this process
     * does not: `{ platform: 'http://platform:3000/api' }`. A contract answered in this process is
     * always called in process.
     */
    endpoints?: Record<string, string>;
    /** Shared secret signing calls between deployments. Required to call or be called over HTTP. */
    secret?: string;
    /** How often to publish events a crashed process left behind (ms). 0 turns the sweeper off. Default 15 s. */
    sweepMs?: number;
  };
}
