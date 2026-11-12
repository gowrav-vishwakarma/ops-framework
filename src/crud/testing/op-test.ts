import type { Transaction } from 'sequelize';
import type { AclScope, AuthUser, Limits } from '../../auth/auth-user.js';
import type { Contract } from '../../services/contract.js';
import { Issues } from '../issues.js';
import type { Attrs, OpContext, Phase, Token } from '../op-context.js';

export interface FakeOpOptions<S extends object, D> {
  /** The record the steps see, as a plain object: `{ id: 1, name: 'HO', isHeadOffice: true }`. */
  row?: Attrs;
  /** Stored values before the operation (update and actions); omit for a create. */
  before?: Attrs | null;
  dto?: D;
  state?: S;
  op?: string;
  user?: Partial<AuthUser>;
  /** Answers for `c.count(sql)`: a number for every query, a map by SQL substring, or a function. */
  counts?: number | Record<string, number> | ((sql: string, replacements: Record<string, unknown>) => number | Promise<number>);
  /** Scope the permission was granted with (`c.scope`). Defaults to `all`. */
  scope?: AclScope;
  /** Authority limits of the granted permission (`c.limits`). */
  limits?: Limits;
  /** Permissions `c.can()` grants. */
  can?: Record<string, AclScope>;
  /** What `c.get(Token)` returns. */
  services?: Array<[Token<unknown>, unknown]>;
  /** Answers of `c.service(Contract)` calls, by `'contract.call'`: `{ 'platform.seats': { used: 1, max: 5 } }` or a function of the input. */
  calls?: Record<string, unknown | ((input: unknown) => unknown)>;
}

/** The context plus what the helpers recorded, for assertions. */
export type FakeOp<M extends Attrs, S extends object, D> = OpContext<never, S, D> & {
  row: M;
  /** Callbacks registered with `c.afterCommit`, not yet run. */
  afterCommits: Array<() => Promise<void> | void>;
  /** Run them, as the commit would. Call it only to test the success path. */
  commit(): Promise<void>;
  savepoints: number;
  separates: number;
  /** Every `c.service()` call made, in order. */
  calls: Array<{ contract: string; call: string; input: unknown; key?: string }>;
  /** Every `c.emit()`, in order. (In a real run they are delivered only after commit.) */
  emitted: Array<{ contract: string; event: string; payload: unknown }>;
};

/**
 * An `OpContext` for unit-testing step files without a database or HTTP. `t` is a placeholder;
 * `savepoint` and `separate` just run the work; `afterCommit` collects callbacks until `commit()`.
 */
export function fakeOpContext<M extends Attrs = Attrs, S extends object = Attrs, D = Attrs>(options: FakeOpOptions<S, D> = {}): FakeOp<M, S, D> {
  const user: AuthUser = {
    id: 1,
    platformUserId: 1,
    companyId: 1,
    epoch: 1,
    branchId: null,
    branchIds: [],
    roleId: 1,
    aclVersion: 0,
    partyId: null,
    name: 'Tester',
    ...options.user,
  };
  const row = (options.row ?? {}) as M;
  const before = options.before === undefined ? null : options.before;
  const services = new Map<unknown, unknown>(options.services ?? []);
  const t = { fake: true } as unknown as Transaction;
  const afterCommits: FakeOp<M, S, D>['afterCommits'] = [];

  const c = {
    op: options.op ?? 'test',
    ctx: { user, scope: options.scope ?? 'all', limits: options.limits ?? {} },
    user,
    scope: options.scope ?? 'all',
    limits: options.limits ?? {},
    t,
    state: (options.state ?? {}) as S,
    issues: new Issues(),
    result: undefined,
    row,
    before,
    dto: (options.dto ?? {}) as D,
    rows: undefined,
    afterCommits,
    savepoints: 0,
    separates: 0,
    count: async (sql: string, replacements: Record<string, unknown>) => {
      const counts = options.counts ?? 0;
      if (typeof counts === 'number') return counts;
      if (typeof counts === 'function') return counts(sql, replacements);
      const hit = Object.entries(counts).find(([part]) => sql.includes(part));
      return hit ? hit[1] : 0;
    },
    sql: async () => [],
    can: async (permission: string) => options.can?.[permission] ?? null,
    get: (token: Token<unknown>) => {
      if (!services.has(token)) throw new Error(`fakeOpContext: no service given for ${String(typeof token === 'function' ? token.name : token)}`);
      return services.get(token);
    },
    calls: [] as FakeOp<M, S, D>['calls'],
    emitted: [] as FakeOp<M, S, D>['emitted'],
    service: (contract: Contract) => {
      const send = async (call: string, input: unknown, callOptions: { key?: string } = {}) => {
        c.calls.push({ contract: contract.name, call, input, key: callOptions.key });
        const name = `${contract.name}.${call}`;
        if (!options.calls || !(name in options.calls)) throw new Error(`fakeOpContext: no answer given for ${name}`);
        const answer = options.calls[name];
        return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : answer;
      };
      return { command: send, query: send };
    },
    emit: async (contract: Contract, event: string, payload: unknown) => {
      c.emitted.push({ contract: contract.name, event, payload });
    },
    savepoint: async <T>(work: (t: Transaction) => Promise<T>) => {
      c.savepoints++;
      return work(t);
    },
    separate: async <T>(work: (t: Transaction) => Promise<T>) => {
      c.separates++;
      return work(t);
    },
    afterCommit: (work: () => Promise<void> | void) => {
      afterCommits.push(work);
    },
    commit: async () => {
      for (const work of afterCommits.splice(0)) await work();
    },
    changed: (field: string) => before === null || String(before[field] ?? '') !== String(row[field] ?? ''),
    unique: async () => undefined,
    reload: async () => row,
  };
  return c as unknown as FakeOp<M, S, D>;
}

/** A step file's default export: an object, or an instance (`new TheClass(fakeDependencies)`). */
export type AnyStep = Partial<Record<Phase, (c: never) => Promise<void>>> & { when?(c: never): boolean };

/**
 * Runs steps in the given order, the way the framework does: `check` steps of all, then `before`,
 * then `after` (pass the phases you want), skipping steps whose `when` is false. The main change
 * between `before` and `after` is not simulated; set `c.row` fields yourself if an `after` step needs them.
 */
export async function runSteps(steps: AnyStep[], c: object, phases: Phase[] = ['check']): Promise<void> {
  for (const phase of phases) {
    for (const step of steps) {
      if (typeof step[phase] !== 'function' || (step.when && !step.when(c as never))) continue;
      await step[phase]!(c as never);
    }
  }
}
