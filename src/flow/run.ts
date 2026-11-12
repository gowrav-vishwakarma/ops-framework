import { UnprocessableEntityException } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import type { Phase } from '../crud/op-context.js';
import { compileExpression, isTrue, type ExpressionScope } from '../expr/evaluate.js';
import type { AclScope, Actor, ReqCtx } from '../auth/auth-user.js';
import { FlowDb, type FlowAccess, type Row } from './flow-db.js';
import { stepKind, type FlowStep } from './kinds.js';

/** An inline method of a flow file: the code part of a flow, called by `{ kind: 'call', method }`. */
export type FlowMethod = (run: FlowRun, args: Record<string, unknown>) => unknown | Promise<unknown>;

/** The operation context as flows see it (a row operation, a list, or a collection action). */
export interface FlowContext {
  op: string;
  t: Transaction;
  /** Who runs the operation, with the scope and limits of the permission that let them. */
  ctx: ReqCtx<Actor>;
  can(code: string): Promise<AclScope | null>;
  user: object;
  state: Record<string, unknown>;
  dto?: unknown;
  row?: unknown;
  before?: Record<string, unknown> | null;
  rows?: unknown[];
  where?: unknown[];
  issues: { block(code: string, message: string): unknown; warn(code: string, message: string): unknown; field(name: string, message: string): unknown; throwIfFailed(message?: string): void };
  get<T>(token: unknown): T;
  afterCommit(work: () => Promise<void> | void): void;
}

/** A value of a row: a model instance (`get`) or, in tests, a plain object. */
export function rowValue(row: unknown, field: string): unknown {
  if (!row || typeof row !== 'object') return undefined;
  const get = (row as { get?: (key: string) => unknown }).get;
  return typeof get === 'function' ? get.call(row, field) : (row as Row)[field];
}

function setRowValue(row: unknown, field: string, value: unknown): void {
  const set = (row as { set?: (key: string, value: unknown) => unknown }).set;
  if (typeof set === 'function') set.call(row, field, value);
  else (row as Row)[field] = value;
}

/** Follows `a.b.c` through plain objects and model instances. */
function walk(source: unknown, path: string[]): unknown {
  let value = source;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    value = rowValue(value, key);
  }
  return value;
}

/**
 * One run of a flow file: the operation's `c`, the phase, the values named by `as`, and helpers the
 * step kinds share (expressions, issues, data). Names an expression can read:
 * `data` (the body or action input), `row`, `before`, `user`, `state`, and every `as` of an earlier step.
 */
export class FlowRun {
  readonly vars = new Map<string, unknown>();

  constructor(
    readonly c: FlowContext,
    readonly phase: Phase,
    readonly file: string,
    readonly methods: Record<string, FlowMethod>,
  ) {}

  get db(): FlowDb {
    return this.c.get<FlowDb>(FlowDb);
  }

  get t(): Transaction {
    return this.c.t;
  }

  /** Data access as the caller (their scope applies), or as the system for integrity checks and `asSystem` steps. */
  access(system = false): FlowAccess {
    return { ctx: this.c.ctx, system, can: async (code) => (await this.c.can(code)) !== null };
  }

  readonly scope: ExpressionScope = {
    name: (path) => {
      const [head, ...rest] = path.split('.');
      const root = this.root(head!);
      return walk(root, rest);
    },
  };

  private root(name: string): unknown {
    if (this.vars.has(name)) return this.vars.get(name);
    switch (name) {
      case 'data':
        return this.c.dto ?? {};
      case 'row':
        return this.c.row;
      case 'before':
        return this.c.before ?? null;
      case 'user':
        return this.c.user;
      case 'state':
        return this.c.state;
      case 'op':
        return this.c.op;
      default:
        throw new UnprocessableEntityException(`${this.file}: unknown name "${name}" in an expression`);
    }
  }

  /** An argument: a string is an expression, anything else is the value itself. */
  value(arg: unknown): unknown {
    return typeof arg === 'string' ? compileExpression(arg).run(this.scope) : arg;
  }

  cond(arg: string | undefined): boolean {
    return arg === undefined ? true : isTrue(this.value(arg));
  }

  values(map: Record<string, unknown> | undefined): Row {
    const out: Row = {};
    for (const [key, arg] of Object.entries(map ?? {})) out[key] = this.value(arg);
    return out;
  }

  /** `Charge "{data.name}" already exists`: `{...}` parts are expressions. */
  text(template: string): string {
    return template.replace(/\{([^{}]+)\}/g, (_all, expr: string) => {
      const value = this.value(expr.trim());
      return value === null || value === undefined ? '' : String(value);
    });
  }

  rowValue(field: string): unknown {
    return rowValue(this.c.row, field);
  }

  setRow(values: Row): void {
    if (!this.c.row) throw new Error(`${this.file}: there is no record here to set fields on`);
    for (const [field, value] of Object.entries(values)) setRowValue(this.c.row, field, value);
  }

  /**
   * Refuses the operation. In the check phase it joins the other issues (all come back together);
   * later the checks are over, so it stops right away with the same 422 shape.
   */
  block(code: string, message: string, field?: string): void {
    if (field) this.c.issues.field(field, message);
    else this.c.issues.block(code, message);
    if (this.phase !== 'check') this.c.issues.throwIfFailed();
  }

  warn(code: string, message: string): void {
    if (this.phase !== 'check') throw new Error(`${this.file}: warnings ask for confirmation, so they belong in check steps`);
    this.c.issues.warn(code, message);
  }

  /** Runs a list of steps in order; `'stop'` ends the whole flow. */
  async steps(list: readonly FlowStep[]): Promise<void | 'stop'> {
    for (const step of list) {
      const { kind: name, when } = step as { kind: string; when?: string };
      if (!this.cond(when)) continue;
      const kind = stepKind(name)!;
      try {
        if ((await kind.run(this, step as never)) === 'stop') return 'stop';
      } catch (error) {
        if (error instanceof Error && !(error as { status?: number }).status && !(error as { getStatus?: unknown }).getStatus) {
          error.message = `[flow ${this.file} ${name}] ${error.message}`;
        }
        throw error;
      }
    }
  }
}
