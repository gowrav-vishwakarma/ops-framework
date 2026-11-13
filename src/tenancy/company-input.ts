import { ForbiddenException, Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { currentTenant } from './context.js';
import { PARTITION } from './partition.js';

/**
 * The company of a request is the signed-in one (token → tenant context), never one the request
 * names. Every body, query and route parameter of a request in a tenant context is searched, at any
 * depth (lines, Sequelize-style `where`, `$include.companyId$` keys): a partition value that is not
 * the signed-in company is refused (403); one that is the signed-in company is removed, so no code
 * can come to rely on it.
 *
 * Runs in `TenantContextGuard` (what the request carries before routing) and as the first global pipe
 * (`CompanyInputPipe`, added by the framework: arguments built later, such as multipart bodies).
 * Requests outside a tenant context (sign-in, login-token and platform routes) are not touched.
 */
export class CompanyInputRefused extends ForbiddenException {
  constructor(where: string) {
    super({ message: `A company cannot be chosen in the request (${where}): the signed-in company is used`, code: 'company_input' });
  }
}

const MAX_DEPTH = 32;

function partitionKey(key: string): boolean {
  const bare = key.replace(/^\$+|\$+$/g, '');
  const last = bare.slice(bare.lastIndexOf('.') + 1);
  return last === PARTITION.field || last === PARTITION.column;
}

/** The plain values under `value` (a value, a list, or an operator object such as `{ $in: [1, 2] }`). */
function leaves(value: unknown, out: unknown[] = [], depth = 0): unknown[] {
  if (depth > MAX_DEPTH) throw new CompanyInputRefused('too deep');
  if (Array.isArray(value)) for (const v of value) leaves(v, out, depth + 1);
  else if (value !== null && typeof value === 'object') for (const v of Object.values(value)) leaves(v, out, depth + 1);
  else out.push(value);
  return out;
}

const empty = (v: unknown) => v === null || v === undefined || v === '';

/**
 * Searches `value` for partition keys. `strip`: remove the ones that name the signed-in company
 * (false where the object cannot be changed, such as Express 5's computed `req.query`).
 */
export function checkCompanyInput(value: unknown, companyId: number | string, where: string, strip = true, depth = 0): void {
  if (depth > MAX_DEPTH) throw new CompanyInputRefused(where);
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value) || value instanceof Date) return;
  if (Array.isArray(value)) {
    for (const item of value) checkCompanyInput(item, companyId, where, strip, depth + 1);
    return;
  }
  for (const key of Object.keys(value)) {
    const inner = (value as Record<string, unknown>)[key];
    if (partitionKey(key)) {
      if (leaves(inner).some((v) => !empty(v) && String(v).trim() !== String(companyId))) throw new CompanyInputRefused(where);
      if (strip) delete (value as Record<string, unknown>)[key];
      continue;
    }
    checkCompanyInput(inner, companyId, where, strip, depth + 1);
  }
}

const CHECKED = new Set<ArgumentMetadata['type']>(['body', 'query', 'param']);

/** The check on handler arguments (body, query, params): the first global pipe, before validation drops unknown fields. */
@Injectable()
export class CompanyInputPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const tenant = currentTenant();
    if (!tenant || !CHECKED.has(metadata.type)) return value;
    // One field taken by name (`@Param('companyId')`, `@Body('companyId')`): checked, and never handed over.
    if (metadata.data && partitionKey(metadata.data)) {
      if (leaves(value).some((v) => !empty(v) && String(v).trim() !== String(tenant.ref.companyId))) throw new CompanyInputRefused(metadata.type);
      return undefined;
    }
    checkCompanyInput(value, tenant.ref.companyId, metadata.type);
    return value;
  }
}
