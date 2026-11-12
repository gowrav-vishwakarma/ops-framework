/**
 * Shared fakes for the flow specs (not a spec itself: no tests here, nothing from vitest).
 * `MemoryDb` keeps tables in memory, understands the conditions the built-in kinds send
 * (equality, `Op.in`, `Op.ne`, `Op.and`, `lower(col) = value`) and records every call, so a spec
 * can say what a step read, wrote and as whom.
 */
import { Op } from 'sequelize';
import type { Phase } from '../crud/op-context.js';
import { fakeOpContext, type FakeOpOptions } from '../crud/testing/op-test.js';
import { FlowDb, type FlowAccess, type Row } from './flow-db.js';
import { flow, runFlow, type FlowPlace } from './flow.js';
import type { FlowStep } from './kinds.js';
import type { FlowMethod } from './run.js';

export interface DbCall {
  kind: 'findOne' | 'findAll' | 'count' | 'create' | 'createMany' | 'update' | 'destroy';
  model: string;
  as: 'system' | 'caller';
  where?: unknown;
  values?: unknown;
  options?: unknown;
}

const isWhereFn = (value: unknown): value is { attribute: { fn: string; args: Array<{ col: string }> }; logic: unknown } =>
  typeof value === 'object' && value !== null && value.constructor?.name === 'Where';

/** True when `row` meets `where`, the way Postgres would for the conditions flows build. */
export function matches(row: Row, where: unknown): boolean {
  if (where === null || where === undefined) return true;
  if (isWhereFn(where)) {
    const { attribute, logic } = where;
    const value = row[attribute.args[0]!.col];
    return attribute.fn === 'lower' && typeof value === 'string' && value.toLowerCase() === logic;
  }
  const condition = where as Record<string | symbol, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(condition)) {
    const parts = condition[symbol] as unknown[];
    if (symbol === Op.and && !parts.every((part) => matches(row, part))) return false;
    if (symbol === Op.or && !parts.some((part) => matches(row, part))) return false;
  }
  return Object.entries(condition).every(([field, wanted]) => {
    const value = row[field];
    if (wanted !== null && typeof wanted === 'object' && !(wanted instanceof Date)) {
      const op = wanted as Record<symbol, unknown>;
      if (Op.in in op) return (op[Op.in] as unknown[]).some((v) => v === value);
      if (Op.ne in op) return value !== op[Op.ne];
      throw new Error(`MemoryDb: condition on ${field} not understood`);
    }
    // `field: null` is `IS NULL` in SQL: a row whose value is missing matches it.
    return wanted === null ? value === null || value === undefined : value === wanted;
  });
}

/** In-memory tables for flows, with a log of every call. */
export class MemoryDb extends FlowDb {
  readonly calls: DbCall[] = [];
  private nextId = 1000;

  constructor(readonly tables: Record<string, Row[]> = {}) {
    super();
  }

  /** `kind:Model:system|caller` of every call, in order. */
  get accessLog(): string[] {
    return this.calls.map((call) => `${call.kind}:${call.model}:${call.as}`);
  }

  private record(kind: DbCall['kind'], model: string, access: FlowAccess, extra: Partial<DbCall> = {}): Row[] {
    this.calls.push({ kind, model, as: access.system ? 'system' : 'caller', ...extra });
    return (this.tables[model] ??= []);
  }

  hasModel(model: string): boolean {
    return model in this.tables;
  }

  async findOne(_t: unknown, access: FlowAccess, model: string, where: Row, attributes?: string[]): Promise<Row | null> {
    const found = this.record('findOne', model, access, { where, options: attributes }).find((row) => matches(row, where));
    return found ? { ...found } : null;
  }

  async findAll(_t: unknown, access: FlowAccess, model: string, where: Row, options?: { attributes?: string[]; limit?: number }): Promise<Row[]> {
    const rows = this.record('findAll', model, access, { where, options }).filter((row) => matches(row, where));
    return rows.slice(0, options?.limit ?? rows.length).map((row) => ({ ...row }));
  }

  async count(_t: unknown, access: FlowAccess, model: string, where: object): Promise<number> {
    return this.record('count', model, access, { where }).filter((row) => matches(row, where)).length;
  }

  async create(_t: unknown, access: FlowAccess, model: string, values: Row): Promise<Row> {
    const row = { id: this.nextId++, ...values };
    this.record('create', model, access, { values }).push(row);
    return { ...row };
  }

  async createMany(_t: unknown, access: FlowAccess, model: string, rows: Row[]): Promise<Row[]> {
    const table = this.record('createMany', model, access, { values: rows });
    return rows.map((values) => {
      const row = { id: this.nextId++, ...values };
      table.push(row);
      return { ...row };
    });
  }

  async update(_t: unknown, access: FlowAccess, model: string, values: Row, where: Row): Promise<number> {
    const rows = this.record('update', model, access, { where, values }).filter((row) => matches(row, where));
    rows.forEach((row) => Object.assign(row, values));
    return rows.length;
  }

  async destroy(_t: unknown, access: FlowAccess, model: string, where: Row): Promise<number> {
    const table = this.record('destroy', model, access, { where });
    const keep = table.filter((row) => !matches(row, where));
    const removed = table.length - keep.length;
    this.tables[model] = keep;
    return removed;
  }
}

export type FakeOpOptionsOf = FakeOpOptions<Record<string, unknown>, Record<string, unknown>>;

/** A fake operation context whose `FlowDb` is `db`; `where`/`rows` for list steps. */
export function flowCtx(db: MemoryDb = new MemoryDb(), options: FakeOpOptionsOf & { where?: unknown[]; rows?: unknown[] } = {}) {
  const { where, rows, ...rest } = options;
  const c = fakeOpContext({ ...rest, services: [[FlowDb, db], ...(rest.services ?? [])] });
  return Object.assign(c, { where, rows }) as typeof c & { where?: unknown[]; rows?: unknown[] };
}

/** Runs steps as one flow file in `phase`. */
export function runSteps(steps: unknown[], phase: Phase, c: object, options: { methods?: Record<string, FlowMethod>; place?: FlowPlace } = {}): Promise<void> {
  return runFlow(flow({ steps: steps as FlowStep[], methods: options.methods }), phase, c, options.place ?? { file: 'spec.ts', op: 'save' });
}

/** Binds steps as the loader would and returns the flow document line (throws what boot would). */
export function bootLine(steps: unknown[], phase: Phase = 'check', place: Partial<FlowPlace> = {}, methods: Record<string, FlowMethod> = {}): string {
  return flow({ steps: steps as FlowStep[], methods }).bindPhase(phase, { file: 'spec.ts', op: 'save', ...place }).describe;
}

/** A thunk that binds the steps, for `expect(...).toThrow()`. */
export const boot =
  (steps: unknown[], phase: Phase = 'check', place: Partial<FlowPlace> = {}, methods: Record<string, FlowMethod> = {}) =>
  () =>
    bootLine(steps, phase, place, methods);
