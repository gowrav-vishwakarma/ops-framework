import type { Type } from '@nestjs/common';
import type { FindAttributeOptions, Includeable, Order, Transaction, WhereOptions } from 'sequelize';
import type { Model } from 'sequelize-typescript';
import type { AclScope, Actor, AuthUser, Limits, ReqCtx } from '../auth/auth-user.js';
import type { Contract, EventsOf, PayloadOf } from '../services/contract.js';
import type { ContractClient } from '../services/service-client.js';
import type { Issues } from './issues.js';
import type { ListQueryDto } from './list-query.dto.js';

export type Attrs = Record<string, unknown>;

/** `SELECT count(*) FROM <sql>` in the operation's transaction. `sql` starts at the table name. */
/** Raw `SELECT` in the operation's transaction (or `t`, a savepoint's). Rows come back as plain objects. */
export type QueryFn = <T = Record<string, unknown>>(sql: string, replacements?: Record<string, unknown> | unknown[], t?: Transaction) => Promise<T[]>;

export type CountFn = (sql: string, replacements: Record<string, unknown>) => Promise<number>;

/** Anything `c.get()` can resolve: a provider class or an injection token. */
export type Token<T> = Type<T> | (abstract new (...args: never[]) => T) | string | symbol;

/**
 * What every step of every operation has. The same object goes to every step in file order, so
 * whatever a step puts in `state` is there for the steps after it.
 */
export interface OpBase<S extends object = Attrs, U extends Actor = AuthUser> {
  /** `create`, `update`, `delete`, an action name, `list`, `list-<view>` or `view-<name>`. */
  op: string;

  // ---- who ----
  /** Who is asking and how far the permission for this operation reaches. */
  ctx: ReqCtx<U>;
  /** The signed-in user (`ctx.user`): id, companyId, branchId, branchIds, roleId, partyId, name. */
  user: U;
  /** Reach of the permission this operation was granted with: `all`, `branch`, `own` or one the resource offers. */
  scope: AclScope;
  /** Authority limits of that permission (`{ amount: 5000 }`). The framework already blocks over-limit records; read it for custom rules. */
  limits: Limits;
  /** The scope the caller holds for another permission (`'party.deactivate'`), or null. Lets a step differ per role. */
  can(permission: string): Promise<AclScope | null>;

  // ---- transaction ----
  /**
   * THE running transaction: shared by every step, the main change and the audit row, and joined
   * from the caller when another service started this operation. Pass `{ transaction: c.t }` to
   * every query. A query without it does not see this operation's own writes.
   */
  t: Transaction;
  /**
   * Work in a SAVEPOINT of the running transaction. If it throws, only that part is rolled back
   * and the throw reaches the step, which may catch it and carry on; the rest of the operation is
   * unaffected. For optional work that must not fail the operation.
   */
  savepoint<T>(work: (t: Transaction) => Promise<T>): Promise<T>;
  /**
   * Work in its OWN transaction, committed when `work` returns, whatever happens to the operation
   * afterwards. For an attempt log or a reserved number that must survive a rollback. Do not touch
   * rows the running transaction has locked or changed: it would wait for them forever.
   */
  separate<T>(work: (t: Transaction) => Promise<T>): Promise<T>;
  /**
   * Runs after the OUTERMOST transaction commits, never on rollback. For notifications, queue
   * jobs and socket pushes. An error here is logged; the data is already saved.
   */
  afterCommit(work: () => Promise<void> | void): void;

  // ---- other services ----
  /**
   * A typed client of another service's contract (`c.service(Platform).command('inviteMember', …)`).
   * The call runs in that service's own transaction, not in `t`: for a change that spans both, do
   * the other side first as a pending record, write here in `t`, and confirm with `c.emit`.
   */
  service<C extends Contract>(contract: C): ContractClient<C>;
  /**
   * Publishes an event of a contract, durably: written in `t`, delivered after commit, never for a
   * rolled-back change. Subscribers in any deployment receive it at least once.
   */
  emit<C extends Contract, E extends EventsOf<C>>(contract: C, event: E, payload: PayloadOf<C['events'][E]>): Promise<void>;

  // ---- services ----
  /**
   * Any provider of the app, resolved when called, without importing its module. Use it for
   * services of other entities, which also avoids circular module imports. Common services
   * (document numbers, exceptions, ACL, notifier) can simply be injected into a class step.
   */
  get<T>(token: Token<T>): T;


  // ---- sharing between steps ----
  /** Shared between the steps of this one operation. Declare its fields optional: earlier steps fill them. */
  state: S;
  /** Field errors, blockers and warnings. Checked once, after the last check step. */
  issues: Issues;
  count: CountFn;
  /** A raw `SELECT` with named replacements, in `c.t`. Pass a savepoint's `t` to run inside it. No schema prefix needed. */
  sql: QueryFn;
  /** What the endpoint returns instead of the record (print data, import summary). Set by any step. */
  result: unknown;
}

/** A create, update, delete, row action or view: one record. */
export interface OpContext<M extends Model, S extends object = Attrs, D = Attrs, U extends Actor = AuthUser> extends OpBase<S, U> {
  /** The record as it will be: on create a built, unsaved row; on update the row with the edits applied. */
  row: M;
  /** Stored values before this operation; null on create. Compare with `row` to see what changes. */
  before: Attrs | null;
  /** Request body on create and update, the validated input on an action. */
  dto: D;
  /** Every record of a bulk action (the steps run once per record); undefined otherwise. */
  rows: M[] | undefined;
  /** True when `field` differs from the stored value (always true on create). */
  changed(field: string): boolean;
  /**
   * Re-reads `c.row` from the database inside `c.t`, so it sees this operation's own writes, and
   * returns it. Later steps see the same object. Before the main change of an update this throws
   * away the edits not yet saved; there, compare with `c.before` instead.
   */
  reload(): Promise<M>;
  /** Field error when another row of the tenant already has this row's value of `field`. */
  unique(field: string): Promise<void>;
}

/** A list or a named list view. `before` steps shape the query, `after` steps decorate the rows. */
export interface ListContext<M extends Model, S extends object = Attrs, U extends Actor = AuthUser> extends OpBase<S, U> {
  query: ListQueryDto;
  /** AND-ed with the permission scope, search and filters. Push extra conditions here. */
  where: WhereOptions[];
  include: Includeable[];
  order: Order;
  limit: number;
  offset: number;
  attributes: FindAttributeOptions | undefined;
  /** Filled by the query; `after` steps may change the rows (`row.setDataValue('x', ...)`). */
  rows: M[];
  total: number;
}

/** A collection action: no record, e.g. an import or a recalculation. */
export interface CollectionContext<S extends object = Attrs, D = Attrs, U extends Actor = AuthUser> extends OpBase<S, U> {
  dto: D;
}

/**
 * The phase is part of the file name: `NNN-check-…`, `NNN-before-…` or `NNN-after-…`.
 *   check    001-399  read only: look at data, add issues, record facts in `state`
 *   before   400-499  after all checks passed and the user confirmed, just before the main change
 *   execute  500      optional `500-execute.ts`: replaces the main change (see `execute()`)
 *   after    501-999  after the main change (insert, update, delete or the action's own effect)
 */
export type Phase = 'check' | 'before' | 'after';

export const PHASE_BANDS: Record<Phase, readonly [number, number]> = {
  check: [1, 399],
  before: [400, 499],
  after: [501, 999],
};

/** Optional fields every step kind has. */
export interface StepMeta<C> {
  /** The step runs only when this returns true, e.g. `(c) => c.changed('status')`. */
  when?(c: C): boolean;
  /** One line for the flow document, e.g. "only when the status changes". */
  describe?: string;
}

/**
 * One step file's default export: an object (no dependencies) or an `@Injectable()` class (needs
 * services). It implements exactly the method its file name's phase names.
 */
export interface Step<M extends Model, S extends object = Attrs, D = Attrs, U extends Actor = AuthUser> extends StepMeta<OpContext<M, S, D, U>> {
  check?(c: OpContext<M, S, D, U>): Promise<void>;
  before?(c: OpContext<M, S, D, U>): Promise<void>;
  after?(c: OpContext<M, S, D, U>): Promise<void>;
}

export interface ListStep<M extends Model, S extends object = Attrs, U extends Actor = AuthUser> extends StepMeta<ListContext<M, S, U>> {
  check?(c: ListContext<M, S, U>): Promise<void>;
  before?(c: ListContext<M, S, U>): Promise<void>;
  after?(c: ListContext<M, S, U>): Promise<void>;
}

export interface CollectionStep<S extends object = Attrs, D = Attrs, U extends Actor = AuthUser> extends StepMeta<CollectionContext<S, D, U>> {
  check?(c: CollectionContext<S, D, U>): Promise<void>;
  before?(c: CollectionContext<S, D, U>): Promise<void>;
  after?(c: CollectionContext<S, D, U>): Promise<void>;
}

/** Typing helper for object steps: `export default step<Branch, DeactivateState>({ async check(c) {…} })`. */
export function step<M extends Model, S extends object = Attrs, D = Attrs, U extends Actor = AuthUser>(definition: Step<M, S, D, U>): Step<M, S, D, U> {
  return definition;
}

export function listStep<M extends Model, S extends object = Attrs, U extends Actor = AuthUser>(definition: ListStep<M, S, U>): ListStep<M, S, U> {
  return definition;
}

export function collectionStep<S extends object = Attrs, D = Attrs, U extends Actor = AuthUser>(definition: CollectionStep<S, D, U>): CollectionStep<S, D, U> {
  return definition;
}

/**
 * `NNN/500-execute.ts`: replaces the operation's main change (the insert, update, delete, or the
 * action's `run`). `original()` runs that built-in change, so an execute file can wrap it or skip it.
 * On create, leave `c.row` saved: its id is what gets audited and returned.
 */
export interface Execute<C> {
  run(c: C, original: () => Promise<void>): Promise<void>;
  /** One line for the flow document. */
  describe?: string;
}

/** Typing helper: `export default execute<Branch>({ async run(c, original) {…} })`. */
export function execute<M extends Model, S extends object = Attrs, D = Attrs, U extends Actor = AuthUser>(definition: Execute<OpContext<M, S, D, U>>): Execute<OpContext<M, S, D, U>> {
  return definition;
}

export function collectionExecute<S extends object = Attrs, D = Attrs, U extends Actor = AuthUser>(definition: Execute<CollectionContext<S, D, U>>): Execute<CollectionContext<S, D, U>> {
  return definition;
}
