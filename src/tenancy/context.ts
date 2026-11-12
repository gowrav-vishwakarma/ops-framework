import { InternalServerErrorException } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { Sequelize } from 'sequelize-typescript';

/** Which tenant a request or job works for: the partition value (the company id). */
export interface TenantRef {
  companyId: number;
  /** The project's string key for the tenant when it has one (Ankpal: the tenant schema name). */
  tenantKey?: string | null;
}

/** Where that tenant's rows live. */
export interface Placement {
  dbKey: string;
  schema: string;
  /** Bumped on every placement change; company tokens carry it. */
  epoch: number;
}

/** What AsyncLocalStorage holds for the running request or job. */
export interface TenantContext {
  ref: TenantRef;
  placement: Placement;
  /** The connection of `placement.dbKey`. */
  sequelize: Sequelize;
}

const KEY = 'framework:tenant';

export class TenantContextError extends InternalServerErrorException {
  constructor(what: string) {
    super(`No tenant context for ${what}. Run it inside a request, or wrap it in TenantRunner.run().`);
  }
}

/** The tenant of the running request or job, or undefined outside one. */
export function currentTenant(): TenantContext | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls.get<TenantContext | undefined>(KEY) : undefined;
  } catch {
    return undefined;
  }
}

export function requireTenant(what = 'a tenant query'): TenantContext {
  const tenant = currentTenant();
  if (!tenant) throw new TenantContextError(what);
  return tenant;
}

/** Called by the guard right after sign-in is verified. */
export function setTenant(tenant: TenantContext): void {
  ClsServiceManager.getClsService().set(KEY, tenant);
}

/** Runs `work` with `tenant` as the current tenant, in a fresh context. */
export function runWithTenant<T>(tenant: TenantContext, work: () => Promise<T>): Promise<T> {
  const cls = ClsServiceManager.getClsService();
  return cls.run(async () => {
    cls.set(KEY, tenant);
    return work();
  });
}

/** Double-quoted Postgres identifier. Only letters, digits and `_` are accepted. */
export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new InternalServerErrorException(`Bad identifier: ${name}`);
  return `"${name}"`;
}

/**
 * `"schema"."table"` of the current tenant, for raw fragments inside ORM calls
 * (`literal(\`(SELECT count(*) FROM ${tbl('users')} u WHERE ...)\`)`), where no model qualifies the table.
 */
export function tbl(table: string): string {
  return `${quoteIdent(requireTenant('tbl()').placement.schema)}.${quoteIdent(table)}`;
}

/** Runs `work` in a fresh context with no tenant: control-plane work called from inside a tenant request. */
export function runWithoutTenant<T>(work: () => Promise<T>): Promise<T> {
  const cls = ClsServiceManager.getClsService();
  return cls.run(async () => {
    cls.set(KEY, undefined);
    return work();
  });
}
