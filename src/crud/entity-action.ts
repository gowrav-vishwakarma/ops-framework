import type { Model } from 'sequelize-typescript';
import type { Type } from '@nestjs/common';
import type { Actor, AuthUser, ReqCtx } from '../auth/auth-user.js';
import type { LimitDef } from '../acl/limits.js';
import type { Attrs, CollectionContext, OpContext } from './op-context.js';

/** An extra input an action asks for, such as a reason. The UI renders it in the action dialog. */
export interface ActionInput {
  id: string;
  label: string;
  kind?: 'text' | 'textarea' | 'date';
  required?: boolean;
}

/**
 * A business operation on one row, other than plain edit: activate, deactivate, approve, close...
 * The service declares what the action is; its checks and side effects are the step files in
 * `ops/<name>/`, run in file order around `run`. Each action is its own permission
 * (`resource.name`), so roles can be given exactly the actions they need.
 */
export interface EntityAction<M extends Model = Model, U extends Actor = AuthUser> {
  /** Route, folder and permission action: `deactivate` is `ops/deactivate/` and `party.deactivate`. */
  name: string;
  label: string;
  /** Permission action when it differs from `name`. */
  permission?: string;
  /** Row state the action starts from, e.g. `{ status: ['active'] }`. Also sent to the UI to enable buttons. */
  from?: Record<string, readonly string[]>;
  /** Confirmation text for the UI. */
  confirm?: string;
  danger?: boolean;
  inputs?: readonly ActionInput[];
  /**
   * `row` (default): one record, `POST /:id/actions/:name`. `bulk`: many records chosen by the user,
   * `POST /actions/:name` with `{ ids }`, all in one transaction, the steps run once per record and
   * every record's blockers are reported together. `collection`: no record (imports, recalculations),
   * `POST /actions/:name`, run with `runCollection`.
   */
  kind?: 'row' | 'bulk' | 'collection';
  /** What a grant of this action can be limited by (an amount, a quantity). Over the limit the action is blocked. */
  limits?: readonly LimitDef<M>[];
  /** Ids of the service's row guards this action does not run (a reopen action skips `period-lock`). */
  skipGuards?: readonly string[];
  /** Works on soft-deleted records (the generated `restore`). */
  onDeleted?: boolean;
  /** A reason this action cannot run on `row` right now (`null` when it can). Used for `_actions`; the steps still check. */
  available?(row: M, ctx: ReqCtx<U>): string | null;

  // ---- how the UI shows it ----
  icon?: string;
  iconColor?: string;
  tooltip?: string;
  /** A desk key, e.g. `Alt+A`. */
  shortcut?: string;
  /** `confirm` asks yes/no, `form` opens the action's inputs, `silent` runs at once. Defaults from `confirm` and `inputs`. */
  ui?: 'confirm' | 'form' | 'silent';
  /** Where the button goes: the toolbar or the row menu. */
  display?: 'toolbar' | 'menu';
  /** Menu section label. */
  group?: string;
  /** Keep the permission out of the role matrix (it is still enforced). */
  hideInAcl?: boolean;
  /** Class-validator DTO the input is validated against before any step runs; steps get an instance as `c.dto`. */
  input?: Type<object>;
  /** The action's main effect, between the `before` and `after` steps. Optional: steps may do all the work. */
  run?(c: OpContext<M, Attrs, unknown, U>): Promise<void>;
  /** Main effect of a `collection` action. */
  runCollection?(c: CollectionContext<Attrs, unknown, U>): Promise<void>;
  /** What `run` does, in a few words, for the flow document: "status -> inactive". */
  effect?: string;
}

/** What the API tells the UI about an action. */
export interface ActionInfo {
  name: string;
  label: string;
  from: Record<string, readonly string[]> | null;
  confirm: string | null;
  kind: 'row' | 'bulk' | 'collection';
  danger: boolean;
  inputs: readonly ActionInput[];
  limits: ReadonlyArray<{ key: string; label: string; type: string }>;
  icon: string | null;
  iconColor: string | null;
  tooltip: string | null;
  shortcut: string | null;
  ui: 'confirm' | 'form' | 'silent';
  display: 'toolbar' | 'menu';
  group: string | null;
  hideInAcl: boolean;
}

/** What `?actions=1` adds to each record: whether the caller can run each action on it now, and why not. */
export type ActionState = { allowed: boolean; reason: string | null };
