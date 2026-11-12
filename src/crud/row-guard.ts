import type { Transaction } from 'sequelize';
import type { Model } from 'sequelize-typescript';
import type { Actor, AuthUser, ReqCtx } from '../auth/auth-user.js';
import type { Attrs } from './op-context.js';

/** What a guard sees for one record. */
export interface GuardInput<M extends Model = Model, U extends Actor = AuthUser> {
  /** `create`, `update`, `delete` or an action name. */
  op: string;
  row: M;
  /** Stored values on update and actions; null on create and in `_actions` hints. */
  before: Attrs | null;
  ctx: ReqCtx<U>;
  /** What `prepare` returned for this operation (or request, for `_actions`). */
  prepared: unknown;
  /** Whether the caller holds another permission (`period.unlock`...). */
  can(code: string): Promise<boolean>;
}

/**
 * A project rule every write of a service must pass before its check steps run: a period lock, a
 * closed financial year, a frozen document. Declared on the service (`guards = [periodLock('invoiceDate')]`),
 * also evaluated for the `_actions` hints, and skipped by an action that lists its id in
 * `skipGuards` (a reopen action). The rule itself is the project's; the framework only runs it.
 */
export interface RowGuard<M extends Model = Model, U extends Actor = AuthUser> {
  /** Stable id: `skipGuards` and the flow document use it. */
  id: string;
  /** Issue code when it blocks. Defaults to the id. */
  code?: string;
  /** One line for the flow document. */
  describe?: string;
  /**
   * Loads what the rule needs once per operation (a bulk action asks once) or once per list for
   * `_actions`: the company's locks, the open financial years. `get` resolves any provider.
   */
  prepare?(ctx: ReqCtx<U>, get: <T>(token: unknown) => T, t?: Transaction): Promise<unknown>;
  /** Why this record may not be changed now, or null. */
  reason(input: GuardInput<M, U>): string | null | Promise<string | null>;
}

/** Guards that apply to an operation: all of the service's, minus the ones the action skips. */
export function guardsFor<M extends Model, U extends Actor>(guards: readonly RowGuard<M, U>[], skip: readonly string[] | undefined): readonly RowGuard<M, U>[] {
  return skip?.length ? guards.filter((guard) => !skip.includes(guard.id)) : guards;
}

/** `prepare` results cached per transaction, so a bulk action loads them once. */
const prepared = new WeakMap<Transaction, Map<string, Promise<unknown>>>();

export function preparedFor<M extends Model, U extends Actor>(
  guard: RowGuard<M, U>,
  ctx: ReqCtx<U>,
  get: <T>(token: unknown) => T,
  t: Transaction,
): Promise<unknown> {
  if (!guard.prepare) return Promise.resolve(undefined);
  let byGuard = prepared.get(t);
  if (!byGuard) prepared.set(t, (byGuard = new Map()));
  let hit = byGuard.get(guard.id);
  if (!hit) byGuard.set(guard.id, (hit = guard.prepare(ctx, get, t)));
  return hit;
}

/**
 * The row guards of every service, by model name, so a write to a model from anywhere (a flow step
 * changing a related row) passes the same project rules as that model's own operations.
 */
export class RowGuardRegistry {
  private readonly byModel = new Map<string, readonly RowGuard<any, any>[]>();

  register(model: string, guards: readonly RowGuard<any, any>[]): void {
    if (!guards.length) return;
    const known = this.byModel.get(model) ?? [];
    this.byModel.set(model, [...known, ...guards.filter((guard) => !known.some((k) => k.id === guard.id))]);
  }

  for(model: string): readonly RowGuard<any, any>[] {
    return this.byModel.get(model) ?? [];
  }
}
