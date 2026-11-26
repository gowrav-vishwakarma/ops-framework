import type { Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { QueryFn } from '../crud/op-context.js';
import type { Rdl2EngineStage, Rdl2StageBase } from './language.js';
import type { ReportUser } from './options.js';

/**
 * Stage kinds a project adds (`defineReportStage`): figures worked out in code for the rows a stage receives, joined
 * back so later stages go on in SQL. The runner compiles the report with the stage's columns empty, reads the keys it
 * receives (`keysSql`, capped at `maxKeys`), asks `work`, and compiles again with the figures in the SQL as one bound
 * JSON value (`joinSql`). Ankpal's `cost` (purchase cost of sales lines) is one; the framework's own `engine` stage is
 * built on it (named engines, `defineReportEngine`).
 */
export interface ReportStageKind<S extends Rdl2StageBase = Rdl2StageBase, U extends ReportUser = ReportUser> {
  kind: S['kind'];
  /** Only reports shipped in code may use it; a saved or sent definition naming it is refused. */
  shippedOnly?: boolean;
  /** Checks the stage against its input's columns and answers the columns it adds. Throw `ReportCompileError`. */
  added(stage: S, input: readonly string[], sql: StageSql): string[];
  /** Input columns its work and join read: column pruning keeps them. */
  reads(stage: S): string[];
  /** The keys to work out, as SQL after `chain.withSql` (the report up to the stage) over `chain.from`. */
  keysSql(stage: S, chain: StageChain, sql: StageSql): string;
  /** Values its `keysSql` binds by name (`:asOn`), beside the report's own and `:companyId`. */
  bindings?(stage: S, params: Readonly<Record<string, unknown>>): Record<string, unknown>;
  /** Keys a run may work out; more is refused (narrow the filters). Default 200,000. */
  maxKeys?: number;
  /** The figures for the keys, JSON-able rows. Runs in the report's read-only transaction. */
  work(keys: Array<Record<string, unknown>>, ctx: StageWork<S, U>): Promise<unknown[]>;
  /** The stage's rows with the figures joined: `figures` is the bound JSON (`jsonb_to_recordset(CAST(<figures> AS jsonb))`). */
  joinSql(stage: S, from: string, figures: string, sql: StageSql): string;
}

/** The report up to a stage. */
export interface StageChain {
  /** `WITH …` of every stage before (empty when it is the first). */
  withSql: string;
  /** The input stage's CTE, quoted. */
  from: string;
}

/** SQL helpers a stage kind compiles with. */
export interface StageSql {
  /** An expression over the stage's input columns (alias `f`), parameters bound. */
  expr(source: string): string;
  /** Bind a value; answers its placeholder. */
  bind(value: unknown): string;
  quote(name: string): string;
  /** The tenant schema (not quoted), for tables a stage reads directly. */
  schema: string;
  /** The report inputs (`@asOn`), already checked. */
  params: Readonly<Record<string, unknown>>;
}

export interface StageWork<S extends Rdl2StageBase, U extends ReportUser> {
  stage: S;
  user: U;
  companyId: number;
  params: Readonly<Record<string, unknown>>;
  t: Transaction;
  /** Read-only SQL in the run's transaction; `:companyId` and the report's bound values are available. */
  sql: QueryFn;
  /** The tenant's connection (its shard), for code that takes one; pass `t`. */
  db: Sequelize;
  /** The report up to the stage and its bound values, for work that reads more of it. */
  chain: StageChain & { replacements: Readonly<Record<string, unknown>> };
  schema: string;
}

const KINDS = new Map<string, ReportStageKind>();
const ENGINES = new Map<string, ReportEngine>();
const NATIVE = new Map<string, NativeStage>();

/** Adds a stage kind every report may use (`{ kind: '<kind>', id, from, … }`). A core kind's name is refused. */
export function defineReportStage<S extends Rdl2StageBase, U extends ReportUser = ReportUser>(kind: ReportStageKind<S, U>): void {
  if (CORE_KINDS.has(kind.kind)) throw new Error(`"${kind.kind}" is a stage kind of the framework`);
  KINDS.set(kind.kind, kind as unknown as ReportStageKind);
}

export function reportStageKind(kind: string): ReportStageKind | undefined {
  return KINDS.get(kind);
}

/** Every kind the compiler knows without a project. */
export const CORE_KINDS = new Set(['source', 'union', 'filter', 'derive', 'aggregate', 'window', 'join', 'exists', 'top', 'pivot', 'balance', 'classify', 'fifo', 'periods', 'native', 'engine']);

// ---------------------------------------------------------------------------- engines

/**
 * A named engine for the `engine` stage: figures the project's own code works out by keys (a bill's due as on a day,
 * an item's stock value), so a report and the app's screens never disagree. Shipped reports only.
 */
export interface ReportEngine<U extends ReportUser = ReportUser> {
  /** The columns it adds. */
  columns: readonly string[];
  /** How many key columns the stage names (`keys`), in this order. Keys are read as bigint. */
  keys: number;
  /** The keys to work out, as SQL over `rows` (key columns `k0`, `k1` …). Bind `:companyId` and `args` as `:<name>`. Default: every distinct key. */
  keysSql?(rows: string, args: Record<string, unknown>): string;
  /** One row per key (`k0` … and the columns); a key it leaves out gets nulls. */
  figures(keys: Array<Record<string, unknown>>, ctx: EngineContext<U>): Promise<Array<Record<string, unknown>>>;
}

export interface EngineContext<U extends ReportUser = ReportUser> {
  companyId: number;
  user: U;
  /** The stage's `args`, inputs resolved (`@asOn` → its value). */
  args: Record<string, unknown>;
  t: Transaction;
  sql: QueryFn;
}

export function defineReportEngine<U extends ReportUser = ReportUser>(name: string, engine: ReportEngine<U>): void {
  ENGINES.set(name, engine as unknown as ReportEngine);
}

export function reportEngine(name: string): ReportEngine | undefined {
  return ENGINES.get(name);
}

/** The stage's args with inputs resolved: `@asOn` is the report input's value. */
export function engineArgs(stage: Rdl2EngineStage, params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(stage.args ?? {}).map(([name, value]) => {
      const input = /^@([A-Za-z_]\w*)$/.exec(String(value).trim());
      return [name, input ? params[input[1]!] : value];
    }),
  );
}

/** The `engine` stage, on the same mechanism as a project's stage kinds. */
export const ENGINE_STAGE: ReportStageKind<Rdl2EngineStage> = {
  kind: 'engine',
  shippedOnly: true,
  added(stage, input) {
    const engine = ENGINES.get(stage.name);
    if (!engine) throw new StageError(`has no engine "${stage.name}"`);
    if (stage.keys?.length !== engine.keys) throw new StageError(`engine "${stage.name}" takes ${engine.keys} key column(s)`);
    for (const key of stage.keys) if (!input.includes(key)) throw new StageError(`has no column "${key}" (columns: ${input.join(', ')})`);
    return [...engine.columns];
  },
  reads: (stage) => stage.keys,
  // The engine's `keysSql` binds its args by name (`:asOn`).
  bindings: (stage, params) => engineArgs(stage, params),
  keysSql(stage, chain, sql) {
    const engine = ENGINES.get(stage.name)!;
    const keyed = `(SELECT ${stage.keys.map((key, i) => `(f.${sql.quote(key)})::bigint AS "k${i}"`).join(', ')} FROM ${chain.from} f WHERE ${stage.keys.map((key) => `f.${sql.quote(key)} IS NOT NULL`).join(' AND ')})`;
    const keys = engine.keysSql ? engine.keysSql(keyed, engineArgs(stage, sql.params)) : `SELECT DISTINCT * FROM ${keyed} keyed`;
    return `${chain.withSql}\n${keys}`;
  },
  work(keys, ctx) {
    return ENGINES.get(ctx.stage.name)!.figures(keys, { companyId: ctx.companyId, user: ctx.user, args: engineArgs(ctx.stage, ctx.params), t: ctx.t, sql: ctx.sql });
  },
  joinSql(stage, from, figures, sql) {
    const engine = ENGINES.get(stage.name)!;
    const keyCols = stage.keys.map((_key, i) => `"k${i}" bigint`);
    const valueCols = engine.columns.map((c) => `${sql.quote(c)} numeric`);
    return `SELECT f.*, ${engine.columns.map((c) => `e.${sql.quote(c)}`).join(', ')}
FROM ${from} f
LEFT JOIN (SELECT * FROM jsonb_to_recordset(CAST(${figures} AS jsonb)) AS x(${[...keyCols, ...valueCols].join(', ')})) e ON ${stage.keys.map((key, i) => `e."k${i}" = (f.${sql.quote(key)})::bigint`).join(' AND ')}`;
  },
};

/** The kind for a stage: a project's, or the framework's `engine`. */
export function computedKind(kind: string): ReportStageKind | undefined {
  return kind === 'engine' ? (ENGINE_STAGE as unknown as ReportStageKind) : KINDS.get(kind);
}

// ---------------------------------------------------------------------------- native

export interface NativeStageContext<U extends ReportUser = ReportUser> {
  params: Readonly<Record<string, unknown>>;
  args: Record<string, unknown>;
  user: U;
}

/** Shapes the rows of the stage before it, in memory, on at most the runner's row cap. */
export type NativeStage<U extends ReportUser = ReportUser> = (rows: Record<string, unknown>[], ctx: NativeStageContext<U>) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];

/** A TypeScript stage for what the language cannot say (a statutory return's own layout): `{ kind: 'native', name }`. */
export function defineNativeStage<U extends ReportUser = ReportUser>(name: string, stage: NativeStage<U>): void {
  NATIVE.set(name, stage as unknown as NativeStage);
}

NATIVE.set('identity', (rows) => rows);

export function nativeStage(name: string): NativeStage | undefined {
  return NATIVE.get(name);
}

/** A stage kind's own refusal; the compiler adds the stage id. */
export class StageError extends Error {}
