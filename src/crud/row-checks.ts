import { checkLimits, type LimitDef } from '../acl/limits.js';
import type { ReqCtx } from '../auth/auth-user.js';
import type { Model } from 'sequelize-typescript';
import type { EntityAction } from './entity-action.js';
import type { Attrs, OpContext } from './op-context.js';
import { checkRefs } from './ref-checks.js';
import { preparedFor, type RowGuard } from './row-guard.js';

/** The reason a record is not in a state the action starts from, or null. */
export function startStateReason<M extends Model>(action: Pick<EntityAction<M, any>, 'from' | 'label' | 'onDeleted'>, row: M): string | null {
  for (const [field, allowed] of Object.entries(action.from ?? {})) {
    const current = String(row.get(field) ?? '');
    if (!allowed.includes(current)) return `${action.label} is not possible while ${field} is "${current}"`;
  }
  if (action.onDeleted && !row.get('deletedAt')) return `${action.label} works on deleted records only`;
  return null;
}

/** What the framework checks of one operation before any check step runs. */
export interface BuiltInChecks<M extends Model> {
  /** Shown in messages: "Approve", "Edit". */
  label: string;
  limits?: readonly LimitDef<M>[];
  /** The service's guards that apply to this operation. */
  guards?: readonly RowGuard<M, any>[];
  /** Check that the references the write sets stay in the record's company (creates and updates). */
  refs?: boolean;
}

/** Blocks when a project guard refuses the record, or it is above the caller's limit. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runBuiltInChecks<M extends Model>(c: OpContext<M, Attrs, any, any>, spec: BuiltInChecks<M>): Promise<void> {
  for (const guard of spec.guards ?? []) {
    const prepared = await preparedFor(guard, c.ctx, (token) => c.get(token as never), c.t);
    const reason = await guard.reason({ op: c.op, row: c.row, before: c.before, ctx: c.ctx, prepared, can: async (code) => (await c.can(code)) !== null });
    if (reason) c.issues.block(guard.code ?? guard.id, reason);
  }
  checkLimits(c.issues, c.ctx, c.row, spec.limits, spec.label);
  if (spec.refs) await checkRefs(c);
}

/** Limits that apply to an operation: the service's `limits` map, or the action's own. */
export function limitsFor<M extends Model>(
  op: string,
  declared: Partial<Record<string, readonly LimitDef<M>[]>>,
  action?: EntityAction<M, any>,
): readonly LimitDef<M>[] | undefined {
  return action?.limits ?? declared[op];
}

export type { ReqCtx };
