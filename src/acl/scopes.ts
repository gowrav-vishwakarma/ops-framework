import { Op, type ModelStatic, type WhereOptions } from 'sequelize';
import type { Model } from 'sequelize-typescript';
import type { Actor, AuthUser, ReqCtx } from '../auth/auth-user.js';

/** What a scope may need to know about the entity that uses it. */
export interface ScopeEnv {
  /** Party columns that make a row "own" for a driver or customer login. */
  partyFields: readonly string[];
}

/**
 * How far a permission reaches. `all`, `branch` and `own` are built in; an app or one resource
 * adds more (`active-only`, `my-team`). A grant stores the id; an id nobody provides is denied.
 */
export interface ScopeDef<M extends Model = Model, U extends Actor = AuthUser> {
  id: string;
  label: string;
  /** Extra condition for list, get and writes. `null` means no limit beyond the tenant. */
  where(ctx: ReqCtx<U>, model: ModelStatic<M>, env: ScopeEnv): WhereOptions | null;
  /** The same rule for one loaded row (`_actions`, checks), without a query. */
  allows?(ctx: ReqCtx<U>, row: M, env: ScopeEnv): boolean;
}

/** A scope by id (built-in or registered by the app) or declared in place. */
export type ScopeRef = string | ScopeDef<never, never>;

const branchIds = (ctx: ReqCtx): number[] => (ctx.user.branchIds.length ? ctx.user.branchIds : [ctx.user.branchId ?? 0]);

export const allScope: ScopeDef<Model, Actor> = { id: 'all', label: 'All records', where: () => null, allows: () => true };

export const branchScope: ScopeDef = {
  id: 'branch',
  label: 'Own branches',
  where: (ctx, model) => ('branchId' in model.getAttributes() ? ({ branchId: { [Op.in]: branchIds(ctx) } } as WhereOptions) : null),
  allows: (ctx, row) => {
    const branch = row.get('branchId') as number | null | undefined;
    return branch === undefined || branchIds(ctx).includes(branch ?? 0);
  },
};

export const ownScope: ScopeDef = {
  id: 'own',
  label: 'Own records',
  where: (ctx, _model, env) => {
    const mine: Array<Record<string, number>> = [{ createdById: ctx.user.id }];
    if (ctx.user.partyId) mine.push(...env.partyFields.map((field) => ({ [field]: ctx.user.partyId as number })));
    return { [Op.or]: mine } as WhereOptions;
  },
  allows: (ctx, row, env) =>
    row.get('createdById') === ctx.user.id ||
    (ctx.user.partyId !== null && env.partyFields.some((field) => row.get(field) === ctx.user.partyId)),
};

export const BUILT_IN_SCOPES: ScopeDef[] = [allScope, branchScope, ownScope];

/** The default of a resource that declares no scopes of its own. */
export const DEFAULT_SCOPE_IDS = ['all', 'branch', 'own'] as const;

/** Scopes a resource offers, resolved: ids come from `registered` (built-ins plus the app's). */
export function resolveScopes(refs: readonly ScopeRef[], registered: readonly ScopeDef[]): Map<string, ScopeDef> {
  const byId = new Map(registered.map((scope) => [scope.id, scope as ScopeDef]));
  const out = new Map<string, ScopeDef>();
  for (const ref of refs) {
    const scope = typeof ref === 'string' ? byId.get(ref) : (ref as unknown as ScopeDef);
    if (!scope) throw new Error(`Unknown scope "${String(ref)}". Register it in FrameworkOptions.scopes or declare it in place.`);
    out.set(scope.id, scope);
  }
  return out;
}
