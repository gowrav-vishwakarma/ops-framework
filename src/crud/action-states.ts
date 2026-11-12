import { limitReason, type LimitDef } from '../acl/limits.js';
import type { EffectivePermissions } from '../acl/acl.service.js';
import type { ScopeDef, ScopeEnv } from '../acl/scopes.js';
import type { ReqCtx } from '../auth/auth-user.js';
import type { Model } from 'sequelize-typescript';
import { startStateReason } from './row-checks.js';
import { guardsFor, type RowGuard } from './row-guard.js';
import type { ActionState, EntityAction } from './entity-action.js';

export interface ActionStateEnv<M extends Model> {
  resource: string;
  actions: readonly EntityAction<M, any>[];
  /** CRUD limits, keyed `update` / `delete` / `create`. */
  limits: Partial<Record<string, readonly LimitDef<M>[]>>;
  guards: readonly RowGuard<M, any>[];
  scopes: Map<string, ScopeDef>;
  scopeEnv: ScopeEnv;
  model: { getAttributes(): Record<string, unknown> };
  actionPermission(action: EntityAction<M, any>): string;
  /** Permission code of a built-in operation (`update`, `delete`). Default `${resource}.${op}`. */
  permission?(op: string): string;
}

/**
 * Whether each action (and edit/delete) can run on a loaded record right now: permission, scope,
 * start state, project guards, authority limit and the action's `available()`. Computed from data
 * already loaded (`prepared` holds each guard's `prepare` result); check steps are not run, so the
 * real call can still refuse.
 */
export async function computeActionStates<M extends Model>(
  env: ActionStateEnv<M>,
  ctx: ReqCtx,
  row: M,
  granted: EffectivePermissions,
  prepared: ReadonlyMap<string, unknown> = new Map(),
): Promise<Record<string, ActionState>> {
  const out: Record<string, ActionState> = {};
  const can = async (code: string) => granted.has(code);
  const decide = async (name: string, code: string, extra: { action?: EntityAction<M, any>; limits?: readonly LimitDef<M>[] }): Promise<ActionState> => {
    const grant = granted.get(code);
    if (!grant) return { allowed: false, reason: 'You do not have permission' };
    const own: ReqCtx = { ...ctx, scope: grant.scope, limits: grant.limits, ...(grant.params ? { scopeParams: grant.params } : {}) };
    const scope = env.scopes.get(grant.scope);
    if (!scope) return { allowed: false, reason: `Unknown access scope "${grant.scope}"` };
    if (scope.allows && !scope.allows(own, row as never, env.scopeEnv)) return { allowed: false, reason: 'Outside your access scope' };
    const { action } = extra;
    const state = action ? startStateReason(action, row) : null;
    if (state) return { allowed: false, reason: state };
    for (const guard of guardsFor(env.guards, action?.skipGuards)) {
      const reason = await guard.reason({ op: name, row, before: null, ctx: own, prepared: prepared.get(guard.id), can });
      if (reason) return { allowed: false, reason };
    }
    const limit = limitReason(own, row, extra.limits);
    if (limit) return { allowed: false, reason: limit };
    const unavailable = action?.available?.(row, own) ?? null;
    return unavailable ? { allowed: false, reason: unavailable } : { allowed: true, reason: null };
  };
  const code = (op: string) => env.permission?.(op) ?? `${env.resource}.${op}`;
  out.update = await decide('update', code('update'), { limits: env.limits.update });
  out.delete = await decide('delete', code('delete'), { limits: env.limits.delete });
  for (const action of env.actions) {
    out[action.name] = await decide(action.name, env.actionPermission(action), { action, limits: action.limits ?? env.limits[action.name] });
  }
  return out;
}
