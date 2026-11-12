import { Injectable } from '@nestjs/common';
import type { Actor, ReqCtx } from '../auth/auth-user.js';
import type { Issues } from '../crud/issues.js';

/**
 * Something a grant can be limited by: "approve invoices up to an amount". The role stores the
 * number; `value` says how big this record is. Over the limit the operation is blocked (a later
 * "route to an approver" can replace the block without changing what entities declare).
 */
export interface LimitDef<R = never> {
  key: string;
  label: string;
  type: 'money' | 'number' | 'qty';
  /** The record's size for this limit. */
  value(row: R, ctx: ReqCtx<Actor>): number;
}

/** What the permission matrix needs to know about a limit (no function). */
export interface LimitInfo {
  key: string;
  label: string;
  type: LimitDef['type'];
}

/** Permission code -> what the matrix needs to know. Services register theirs at boot. */
@Injectable()
export class PermissionMeta {
  private readonly limitsByCode = new Map<string, readonly LimitInfo[]>();
  private readonly hiddenCodes = new Set<string>();

  declareLimits(code: string, limits: readonly LimitDef<never>[]): void {
    if (limits.length) this.limitsByCode.set(code, limits.map(({ key, label, type }) => ({ key, label, type })));
  }

  /** Keeps a permission out of the role matrix (it is still enforced). */
  hide(code: string): void {
    this.hiddenCodes.add(code);
  }

  limits(code: string): readonly LimitInfo[] {
    return this.limitsByCode.get(code) ?? [];
  }

  isHidden(code: string): boolean {
    return this.hiddenCodes.has(code);
  }
}

const money = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** Blocks when a record is above a stored limit. Unset limits are unlimited. */
export function checkLimits<R>(issues: Issues, ctx: ReqCtx<Actor>, row: R, defs: readonly LimitDef<R>[] | undefined, what: string): void {
  for (const def of defs ?? []) {
    const limit = ctx.limits[def.key];
    if (limit === undefined || limit === null) continue;
    const value = def.value(row, ctx);
    if (value > limit) {
      issues.block('limit_exceeded', `${what} is allowed ${def.label.toLowerCase()} ${money.format(limit)}; this is ${money.format(value)}`);
    }
  }
}

/** The reason a limit would block, without an `Issues` (for `_actions`). */
export function limitReason<R>(ctx: ReqCtx<Actor>, row: R, defs: readonly LimitDef<R>[] | undefined): string | null {
  for (const def of defs ?? []) {
    const limit = ctx.limits[def.key];
    if (limit === undefined || limit === null) continue;
    if (def.value(row, ctx) > limit) return `Above your limit of ${money.format(limit)}`;
  }
  return null;
}
