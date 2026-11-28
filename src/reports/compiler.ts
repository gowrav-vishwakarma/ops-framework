import { ExpressionError, expressionNames, parseExpression } from '../expr/parse.js';
import { compileSql, SqlBinder } from '../expr/sql.js';
import { periodSpanParams, resolvePeriods, type Rdl2ResolvedPeriod } from './periods.js';
import type { CatalogModel, ModelCatalog } from './catalog.js';
import { computedKind, StageError, type StageSql } from './stages.js';
import type {
  Rdl2AggregateFn,
  Rdl2AggregateStage,
  Rdl2BalanceStage,
  Rdl2ClassifyStage,
  Rdl2DeriveStage,
  Rdl2ExistsStage,
  Rdl2FifoStage,
  Rdl2FilterStage,
  Rdl2JoinStage,
  Rdl2Param,
  Rdl2PeriodsStage,
  Rdl2PivotStage,
  Rdl2Report,
  Rdl2SourceStage,
  Rdl2Stage,
  Rdl2StageBase,
  Rdl2TopStage,
  Rdl2UnionStage,
  Rdl2WindowStage,
} from './language.js';

/** A definition problem, with the stage it is in. Shown to the designer as is. */
export class ReportCompileError extends Error {
  constructor(
    message: string,
    readonly stage?: string,
  ) {
    super(stage ? `${stage}: ${message}` : message);
  }
}

export interface ReportScope {
  tenantSchema: string;
  companyId: number;
  /** Row-scope values the run may read (`reports.rowScope`, such as branches). Null: all. Empty: none. */
  rowIds: Array<number | string> | null;
}

export interface ReportCompileContext {
  catalog: ModelCatalog;
  scope: ReportScope;
  params: Record<string, unknown>;
  binder: SqlBinder;
  /** The report's inputs, for `under(@input)` (set by `compileStages`). */
  paramDefs?: readonly Rdl2Param[];
  /** Figures of computed stages (`stages.ts`) the runner has worked out, by stage id, as JSON. */
  figures?: ReadonlyMap<string, string>;
}

export interface Rdl2Compiled {
  /** `WITH ... ` chain; select from `cte(stageId)` after it. */
  withSql: string;
  /** Column names of each stage. */
  columns: Map<string, string[]>;
  cte: (stageId: string) => string;
  /** Computed stages compiled without their figures (empty columns): the runner works them out and compiles again. */
  pending: Rdl2StageBase[];
  /** Periods of `periods` stages, in order. */
  periods: Rdl2ResolvedPeriod[];
}

const MAX_STAGES = 60;
const MAX_JOINS = 14;
const IDENT = /^[A-Za-z_]\w*$/;

export function quoteIdent(name: string): string {
  if (!IDENT.test(name)) throw new ReportCompileError(`"${name}" is not a valid name (letters, digits and _)`);
  return `"${name}"`;
}

function cteName(id: string): string {
  return `st_${id}`;
}

/** Compile every stage up to and including `until` (default: all), in order. */
export function compileStages(report: Rdl2Report<Rdl2StageBase>, given: ReportCompileContext, until?: string): Rdl2Compiled {
  if (report.stages.length > MAX_STAGES) throw new ReportCompileError(`A report has at most ${MAX_STAGES} stages`);
  // Periods are known before any stage compiles, so a source before them can read their span.
  const periods: Rdl2ResolvedPeriod[] = [];
  const spans: Record<string, string> = {};
  for (const stage of report.stages) {
    if (stage.kind !== 'periods') continue;
    const resolved = resolvePeriods(stage as Rdl2PeriodsStage, given.params);
    periods.push(...resolved);
    Object.assign(spans, periodSpanParams(resolved, stage.id));
  }
  const ctx: ReportCompileContext = { ...given, params: { ...given.params, ...spans }, paramDefs: report.params };
  const columns = new Map<string, string[]>();
  const parts: string[] = [];
  const seen = new Set<string>();
  const pending: Rdl2StageBase[] = [];
  // A stage another one joins or matches against is worked out once. Inlined, Postgres may run it
  // again for every row of the other side (a grouped lookup joined to a few rows took 26 s).
  const lookups = new Set(
    report.stages.flatMap((stage) => (stage.kind === 'join' ? [(stage as Rdl2JoinStage).with] : stage.kind === 'exists' ? [(stage as Rdl2ExistsStage).in] : [])),
  );
  for (const stage of report.stages) {
    if (!IDENT.test(stage.id)) throw new ReportCompileError('Stage ids use letters, digits and _', stage.id);
    if (seen.has(stage.id)) throw new ReportCompileError('Two stages share this id', stage.id);
    seen.add(stage.id);
    if (stage.kind === 'native') throw new ReportCompileError('A native stage runs after SQL; it must be the last stage', stage.id);
    let sql: string;
    try {
      const computed = computedKind(stage.kind);
      sql = computed
        ? compileComputed(stage, computed, ctx, columns, pending)
        : stage.kind === 'periods'
          ? compilePeriods(stage as Rdl2PeriodsStage, ctx, columns, periods.filter((period) => period.stage === stage.id))
          : compileStage(stage as Rdl2Stage, ctx, columns);
    } catch (error) {
      if (error instanceof ReportCompileError) throw error;
      if (error instanceof ExpressionError || error instanceof StageError) throw new ReportCompileError(error.message, stage.id);
      throw error;
    }
    parts.push(`${quoteIdent(cteName(stage.id))} AS ${lookups.has(stage.id) ? 'MATERIALIZED ' : ''}(\n${sql}\n)`);
    if (until && stage.id === until) break;
  }
  return { withSql: parts.length ? `WITH ${parts.join(',\n')}` : '', columns, cte: (id) => quoteIdent(cteName(id)), pending, periods };
}

function input(columns: Map<string, string[]>, id: string, stage: string): string[] {
  const cols = columns.get(id);
  if (!cols) throw new ReportCompileError(`uses stage "${id}", which is not defined before it`, stage);
  return cols;
}

function columnResolver(cols: string[], stage: string, alias?: string): (name: string) => string {
  return (name) => {
    if (!cols.includes(name)) throw new ReportCompileError(`has no column "${name}" (columns: ${cols.join(', ')})`, stage);
    return alias ? `${alias}.${quoteIdent(name)}` : quoteIdent(name);
  };
}

function expr(src: string, ctx: ReportCompileContext, name: (n: string) => string): string {
  return compileSql(src, { name, param: (id) => paramValue(ctx, id), binder: ctx.binder, under: (id) => underSql(ctx, id) });
}

/**
 * `in under(@input)`: the rows the input picked and every row under them in their tree. The
 * input is a lookup on a model kept as a nested set (`left` / `right`, such as AccountGroup), so a
 * row is under a picked one when its range sits inside the picked one's. Company-scoped.
 */
function underSql(ctx: ReportCompileContext, id: string): string | null {
  const param = ctx.paramDefs?.find((item) => item.id === id);
  if (!param) throw new ExpressionError(`Unknown parameter @${id}`);
  const modelName = param.type === 'lookup' ? param.lookup?.model : undefined;
  const model = modelName ? ctx.catalog.models[modelName] : undefined;
  const left = model?.fields.find((field) => field.name === 'left');
  const right = model?.fields.find((field) => field.name === 'right');
  const key = model?.fields.find((field) => field.name === (param.lookup?.value ?? 'id'));
  if (!model || !left || !right || !key) throw new ExpressionError(`under(@${id}) needs a lookup on a tree, such as AccountGroup`);
  if (!model.scope.company && !model.scope.companyShared) throw new ExpressionError(`${model.label} has no company column and is not shared by every company, so a report cannot read it`);
  const picked = paramValue(ctx, id);
  const ids = (Array.isArray(picked) ? picked : picked === null || picked === undefined ? [] : [picked]).filter((value) => value !== null && value !== '');
  if (!ids.length) return null;
  const table = `${quoteIdent(ctx.scope.tenantSchema)}.${quoteIdent(model.table)}`;
  const companyColumn = model.scope.company;
  const company = companyColumn ? (alias: string) => ` AND ${alias}.${quoteIdent(companyColumn)} = ${ctx.binder.bind(ctx.scope.companyId)}` : () => '';
  const col = (alias: string, field: { column: string }) => `${alias}.${quoteIdent(field.column)}`;
  return `SELECT ${col('c', key)} FROM ${table} c WHERE EXISTS (SELECT 1 FROM ${table} p WHERE ${col('p', key)} IN (${ctx.binder.bind(ids)})${company('p')} AND ${col('c', left)} >= ${col('p', left)} AND ${col('c', right)} <= ${col('p', right)})${company('c')}`;
}

function paramValue(ctx: ReportCompileContext, id: string): unknown {
  if (!(id in ctx.params)) throw new ExpressionError(`Unknown parameter @${id}`);
  return ctx.params[id];
}

function compileStage(stage: Rdl2Stage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  switch (stage.kind) {
    case 'source':
      return compileSource(stage, ctx, columns);
    case 'union':
      return compileUnion(stage, ctx, columns);
    case 'filter':
      return compileFilter(stage, ctx, columns);
    case 'derive':
      return compileDerive(stage, ctx, columns);
    case 'aggregate':
      return compileAggregate(stage, ctx, columns);
    case 'window':
      return compileWindow(stage, ctx, columns);
    case 'join':
      return compileJoin(stage, ctx, columns);
    case 'exists':
      return compileExists(stage, ctx, columns);
    case 'top':
      return compileTop(stage, ctx, columns);
    case 'pivot':
      return compilePivot(stage, ctx, columns);
    case 'balance':
      return compileBalance(stage, ctx, columns);
    case 'classify':
      return compileClassify(stage, ctx, columns);
    case 'fifo':
      return compileFifo(stage, ctx, columns);
    default:
      throw new ReportCompileError(`Unknown stage kind "${(stage as { kind: string }).kind}"`, (stage as { id: string }).id);
  }
}

// ---------------------------------------------------------------------------- source

interface JoinPlan {
  alias: string;
  model: CatalogModel;
  sql: string;
}

function table(ctx: ReportCompileContext, model: CatalogModel): string {
  return `${quoteIdent(ctx.scope.tenantSchema)}.${quoteIdent(model.table)}`;
}

/** Company and soft-delete conditions every row of a model must meet, wherever it is read. */
function rowScope(ctx: ReportCompileContext, model: CatalogModel, alias: string): string[] {
  const out: string[] = [];
  const { company, softDelete } = model.scope;
  if (company) out.push(`${alias}.${quoteIdent(company)} = ${ctx.binder.bind(ctx.scope.companyId)}`);
  if (softDelete?.kind === 'flag') out.push(`COALESCE(${alias}.${quoteIdent(softDelete.column)}, false) = false`);
  if (softDelete?.kind === 'timestamp') out.push(`${alias}.${quoteIdent(softDelete.column)} IS NULL`);
  return out;
}

/** A model without the company column is read only when every company shares it; else no report reads it. */
function companyGuard(model: CatalogModel, stage: string): void {
  if (!model.scope.company && !model.scope.companyShared) {
    throw new ReportCompileError(`${model.label} has no company column and is not shared by every company, so a report cannot read it`, stage);
  }
}

function column(model: CatalogModel, field: string, stage: string): string {
  const found = model.fields.find((item) => item.name === field);
  if (!found) throw new ReportCompileError(`${model.label} has no field "${field}"`, stage);
  return found.column;
}

function compileSource(stage: Rdl2SourceStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const base = ctx.catalog.models[stage.model];
  if (!base) throw new ReportCompileError(`"${stage.model}" is not a model a report can read`, stage.id);
  if (!stage.fields.length) throw new ReportCompileError('picks no fields', stage.id);
  companyGuard(base, stage.id);
  const joins = new Map<string, JoinPlan>();
  const root: JoinPlan = { alias: 't0', model: base, sql: '' };

  /** Join every relation on the way to a path's last segment and return its alias and model. */
  const reach = (relations: string[]): JoinPlan => {
    let current = root;
    let key = '';
    for (const name of relations) {
      key = key ? `${key}.${name}` : name;
      const existing = joins.get(key);
      if (existing) {
        current = existing;
        continue;
      }
      const relation = current.model.relations.find((item) => item.name === name);
      if (!relation) throw new ReportCompileError(`${current.model.label} has no relation "${name}"`, stage.id);
      if (relation.type === 'many') {
        throw new ReportCompileError(
          `"${key}" holds many rows per ${current.model.label}. Start a source on ${relation.target} and aggregate it instead`,
          stage.id,
        );
      }
      const target = ctx.catalog.models[relation.target];
      if (!target) throw new ReportCompileError(`"${relation.target}" is not readable`, stage.id);
      companyGuard(target, stage.id);
      if (joins.size >= MAX_JOINS) throw new ReportCompileError(`reads more than ${MAX_JOINS} relations`, stage.id);
      const alias = `t${joins.size + 1}`;
      const on = [
        `${alias}.${quoteIdent(column(target, relation.targetKey, stage.id))} = ${current.alias}.${quoteIdent(column(current.model, relation.sourceKey, stage.id))}`,
        // The relation's own condition (an account's billing address is one of its addresses), bound.
        ...(relation.where ?? []).map(({ field, value }) =>
          value === null ? `${alias}.${quoteIdent(column(target, field, stage.id))} IS NULL` : `${alias}.${quoteIdent(column(target, field, stage.id))} = ${ctx.binder.bind(value)}`,
        ),
        ...rowScope(ctx, target, alias),
      ];
      const plan: JoinPlan = { alias, model: target, sql: `LEFT JOIN ${table(ctx, target)} ${alias} ON ${on.join(' AND ')}` };
      joins.set(key, plan);
      current = plan;
    }
    return current;
  };

  const path = (dotted: string): string => {
    const segments = dotted.split('.');
    const field = segments.pop()!;
    const plan = reach(segments);
    return `${plan.alias}.${quoteIdent(column(plan.model, field, stage.id))}`;
  };

  const select = stage.fields.map((field) => `${path(field.path)} AS ${quoteIdent(field.as)}`);
  const where = rowScope(ctx, base, 't0');

  if (stage.branchScope !== 'none' && ctx.scope.rowIds !== null) {
    // Nothing allowed reads nothing: an empty IN list is not valid SQL.
    const ids = ctx.binder.bind(ctx.scope.rowIds.length > 0 ? ctx.scope.rowIds : [null]);
    // Any of the model's scope columns is enough: `(a IN ids OR b IN ids)`.
    const within = (alias: string, model: CatalogModel): string | null => {
      const columns = model.scope.rowColumns ?? (model.scope.rowColumn ? [model.scope.rowColumn] : []);
      if (!columns.length) return null;
      const parts = columns.map((col) => `${alias}.${quoteIdent(col)} IN (${ids})`);
      return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
    };
    if (base.scope.row === 'own') {
      const condition = within('t0', base);
      if (condition) where.push(condition);
    } else if (base.scope.row === 'path' && base.scope.rowPath) {
      const header = reach(base.scope.rowPath.split('.'));
      const condition = within(header.alias, header.model);
      if (condition) where.push(condition);
    } else if (!base.scope.rowShared && ctx.catalog.unscoped === 'refuse') {
      const words = ctx.catalog.rowLabel ?? { one: 'scope', many: 'scopes' };
      throw new ReportCompileError(`${base.label} is not limited by ${words.one}, so a right limited to some ${words.many} cannot read it`, stage.id);
    }
  }

  if (stage.where) {
    const ast = parseExpression(stage.where);
    // Join what the condition reads before compiling it, so `party.city.name` works too.
    for (const name of expressionNames(ast)) path(name);
    where.push(expr(stage.where, ctx, path));
  }

  columns.set(
    stage.id,
    stage.fields.map((field) => field.as),
  );
  const fromSql = [`FROM ${table(ctx, base)} t0`, ...[...joins.values()].map((plan) => plan.sql)].join('\n');
  return `SELECT ${select.join(', ')}\n${fromSql}\nWHERE ${where.length ? where.join(' AND ') : 'TRUE'}`;
}

// ---------------------------------------------------------------------------- row stages

function compileUnion(stage: Rdl2UnionStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  if (stage.parts.length < 2) throw new ReportCompileError('combines at least two stages', stage.id);
  const first = stage.parts[0]!;
  const listed = [...new Set([...input(columns, first.from, stage.id), ...Object.keys(first.set ?? {})])];
  const missing = (stage.keep ?? []).filter((col) => !listed.includes(col));
  if (missing.length) throw new ReportCompileError(`keeps columns it does not have: ${missing.join(', ')}`, stage.id);
  const target = stage.keep ? listed.filter((col) => stage.keep!.includes(col)) : listed;
  const selects = stage.parts.map((part) => {
    const cols = input(columns, part.from, stage.id);
    const name = columnResolver(cols, stage.id);
    const list = target.map((col) => {
      const set = part.set?.[col];
      if (set !== undefined) return `${expr(set, ctx, name)} AS ${quoteIdent(col)}`;
      if (!cols.includes(col)) throw new ReportCompileError(`part "${part.from}" has no column "${col}"; give it with set`, stage.id);
      return quoteIdent(col);
    });
    return `SELECT ${list.join(', ')} FROM ${quoteIdent(cteName(part.from))}`;
  });
  columns.set(stage.id, target);
  return selects.join('\nUNION ALL\n');
}

function compileFilter(stage: Rdl2FilterStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const cols = input(columns, stage.from, stage.id);
  columns.set(stage.id, cols);
  return `SELECT * FROM ${quoteIdent(cteName(stage.from))} WHERE ${expr(stage.where, ctx, columnResolver(cols, stage.id))}`;
}

function compileDerive(stage: Rdl2DeriveStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const cols = input(columns, stage.from, stage.id);
  const name = columnResolver(cols, stage.id);
  const derived = new Map(stage.columns.map((item) => [item.as, expr(item.expr, ctx, name)]));
  const all = [...cols.filter((col) => !derived.has(col)), ...stage.columns.map((item) => item.as)];
  const kept = stage.keep ? stage.keep.filter((col) => all.includes(col)) : all;
  if (stage.keep && kept.length !== stage.keep.length) {
    throw new ReportCompileError(`keeps columns it does not have: ${stage.keep.filter((col) => !all.includes(col)).join(', ')}`, stage.id);
  }
  columns.set(stage.id, kept);
  const list = kept.map((col) => (derived.has(col) ? `${derived.get(col)} AS ${quoteIdent(col)}` : quoteIdent(col)));
  return `SELECT ${list.join(', ')} FROM ${quoteIdent(cteName(stage.from))}`;
}

function aggregateSql(fn: Rdl2AggregateFn, value: string | null, filter: string | null, separator: string | undefined, orderBy: string | null, stage: string, ctx: ReportCompileContext): string {
  const where = filter ? ` FILTER (WHERE ${filter})` : '';
  const need = (): string => {
    if (!value) throw new ReportCompileError(`${fn} needs a value`, stage);
    return value;
  };
  switch (fn) {
    case 'sum':
      return `COALESCE(SUM(${need()})${where}, 0)`;
    case 'count':
      return `COUNT(${value ?? '*'})${where}`;
    case 'countDistinct':
      return `COUNT(DISTINCT ${need()})${where}`;
    case 'min':
      return `MIN(${need()})${where}`;
    case 'max':
      return `MAX(${need()})${where}`;
    case 'avg':
      return `AVG(${need()})${where}`;
    case 'list':
      return `STRING_AGG(DISTINCT (${need()})::text, ${ctx.binder.bind(separator ?? ', ')})${where}`;
    case 'first':
    case 'last': {
      const order = orderBy ?? need();
      return `(ARRAY_AGG(${need()} ORDER BY ${order} ${fn === 'first' ? 'ASC' : 'DESC'})${where})[1]`;
    }
    default:
      throw new ReportCompileError(`Unknown aggregate "${fn as string}"`, stage);
  }
}

function compileAggregate(stage: Rdl2AggregateStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const cols = input(columns, stage.from, stage.id);
  const name = columnResolver(cols, stage.id);
  stage.groupBy.forEach((col) => name(col));
  if (!stage.measures.length && !stage.groupBy.length) throw new ReportCompileError('groups nothing and measures nothing', stage.id);
  const measures = stage.measures.map((m) => {
    const value = m.expr ? expr(m.expr, ctx, name) : null;
    const filter = m.where ? expr(m.where, ctx, name) : null;
    const order = m.orderBy ? expr(m.orderBy, ctx, name) : null;
    return `${aggregateSql(m.fn, value, filter, m.separator, order, stage.id, ctx)} AS ${quoteIdent(m.as)}`;
  });
  const out = [...stage.groupBy, ...stage.measures.map((m) => m.as)];
  columns.set(stage.id, out);
  const group = stage.groupBy.map(quoteIdent);
  const sql = `SELECT ${[...group, ...measures].join(', ')} FROM ${quoteIdent(cteName(stage.from))}${group.length ? ` GROUP BY ${group.join(', ')}` : ''}`;
  if (!stage.having) return sql;
  return `SELECT * FROM (${sql}) g WHERE ${expr(stage.having, ctx, columnResolver(out, stage.id))}`;
}

function orderSql(list: { expr: string; dir?: 'asc' | 'desc' }[] | undefined, ctx: ReportCompileContext, name: (n: string) => string): string {
  if (!list?.length) return '';
  return `ORDER BY ${list.map((item) => `${expr(item.expr, ctx, name)} ${item.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ')}`;
}

function compileWindow(stage: Rdl2WindowStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const cols = input(columns, stage.from, stage.id);
  const name = columnResolver(cols, stage.id);
  const list = stage.columns.map((c) => {
    const partition = c.partitionBy?.length ? `PARTITION BY ${c.partitionBy.map((col) => name(col)).join(', ')}` : '';
    const order = orderSql(c.orderBy, ctx, name);
    const value = c.expr ? expr(c.expr, ctx, name) : null;
    const need = (): string => {
      if (!value) throw new ReportCompileError(`${c.fn} needs a value`, stage.id);
      return value;
    };
    const needOrder = (): string => {
      if (!order) throw new ReportCompileError(`${c.fn} needs an order`, stage.id);
      return order;
    };
    let sql: string;
    switch (c.fn) {
      case 'runningSum':
        sql = `SUM(${need()}) OVER (${partition} ${needOrder()} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
        break;
      case 'rowNumber':
        sql = `ROW_NUMBER() OVER (${partition} ${needOrder()})`;
        break;
      case 'rank':
        sql = `RANK() OVER (${partition} ${needOrder()})`;
        break;
      case 'denseRank':
        sql = `DENSE_RANK() OVER (${partition} ${needOrder()})`;
        break;
      case 'previous':
        sql = `LAG(${need()}) OVER (${partition} ${needOrder()})`;
        break;
      case 'next':
        sql = `LEAD(${need()}) OVER (${partition} ${needOrder()})`;
        break;
      case 'partitionSum':
        sql = `SUM(${need()}) OVER (${partition})`;
        break;
      case 'partitionCount':
        sql = `COUNT(*) OVER (${partition})`;
        break;
      case 'share':
        // Percent of the partition's total: 100 * value / sum.
        sql = `(100.0 * (${need()})) / NULLIF(SUM(${need()}) OVER (${partition}), 0)`;
        break;
      case 'list':
        // The whole partition's values, whatever the row's position in it.
        sql = `STRING_AGG(NULLIF((${need()})::text, ''), ', ') OVER (${partition})`;
        break;
      default:
        throw new ReportCompileError(
          c.fn
            ? `Column "${c.as}": unknown window function "${c.fn as string}"`
            : `Column "${c.as}" has no fn (rank, runningSum, share…); put a plain calculation in a derive step`,
          stage.id,
        );
    }
    return { as: c.as, sql };
  });
  const added = new Set(list.map((item) => item.as));
  const out = [...cols.filter((col) => !added.has(col)), ...list.map((item) => item.as)];
  columns.set(stage.id, out);
  const select = [...cols.filter((col) => !added.has(col)).map(quoteIdent), ...list.map((item) => `${item.sql} AS ${quoteIdent(item.as)}`)];
  return `SELECT ${select.join(', ')} FROM ${quoteIdent(cteName(stage.from))}`;
}

function onSql(on: { left: string; right: string }[], left: string[], right: string[], stage: string): string {
  if (!on.length) throw new ReportCompileError('needs at least one matching column pair', stage);
  const l = columnResolver(left, stage, 'a');
  const r = columnResolver(right, stage, 'b');
  return on.map((pair) => `${l(pair.left)} = ${r(pair.right)}`).join(' AND ');
}

function compileJoin(stage: Rdl2JoinStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  void ctx;
  const left = input(columns, stage.from, stage.id);
  const right = input(columns, stage.with, stage.id);
  const r = columnResolver(right, stage.id, 'b');
  const taken = stage.columns.map((c) => `${r(c.column)} AS ${quoteIdent(c.as)}`);
  const clash = stage.columns.find((c) => left.includes(c.as));
  if (clash) throw new ReportCompileError(`already has a column "${clash.as}"; name the joined one differently`, stage.id);
  columns.set(stage.id, [...left, ...stage.columns.map((c) => c.as)]);
  const type = stage.type === 'inner' ? 'INNER JOIN' : 'LEFT JOIN';
  // A join may take no columns: an inner join that only keeps matching rows.
  return `SELECT ${['a.*', ...taken].join(', ')} FROM ${quoteIdent(cteName(stage.from))} a ${type} ${quoteIdent(cteName(stage.with))} b ON ${onSql(stage.on, left, right, stage.id)}`;
}

function compileExists(stage: Rdl2ExistsStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const left = input(columns, stage.from, stage.id);
  const right = input(columns, stage.in, stage.id);
  const extra = stage.where ? ` AND ${expr(stage.where, ctx, columnResolver(right, stage.id, 'b'))}` : '';
  columns.set(stage.id, left);
  return `SELECT a.* FROM ${quoteIdent(cteName(stage.from))} a WHERE ${stage.negate ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${quoteIdent(cteName(stage.in))} b WHERE ${onSql(stage.on, left, right, stage.id)}${extra})`;
}

function compileTop(stage: Rdl2TopStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const cols = input(columns, stage.from, stage.id);
  const name = columnResolver(cols, stage.id);
  const partition = stage.partitionBy.map((col) => name(col)).join(', ');
  const order = orderSql(stage.orderBy, ctx, name);
  if (!order) throw new ReportCompileError('needs an order', stage.id);
  const keep = Math.max(1, Math.floor(stage.keep ?? 1));
  columns.set(stage.id, cols);
  return `SELECT ${cols.map(quoteIdent).join(', ')} FROM (SELECT *, ROW_NUMBER() OVER (${partition ? `PARTITION BY ${partition}` : ''} ${order}) AS "__rn" FROM ${quoteIdent(cteName(stage.from))}) x WHERE "__rn" <= ${keep}`;
}

function compilePivot(stage: Rdl2PivotStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const cols = input(columns, stage.from, stage.id);
  const name = columnResolver(cols, stage.id);
  if (!stage.keys.length) throw new ReportCompileError('lists no keys', stage.id);
  const col = name(stage.column);
  const value = stage.measure.expr ? expr(stage.measure.expr, ctx, name) : null;
  const measures = stage.keys.map(
    (key) => `${aggregateSql(stage.measure.fn, value, `${col} = ${ctx.binder.bind(key.value)}`, undefined, null, stage.id, ctx)} AS ${quoteIdent(key.as)}`,
  );
  if (stage.total) measures.push(`${aggregateSql(stage.measure.fn, value, null, undefined, null, stage.id, ctx)} AS ${quoteIdent(stage.total)}`);
  const rows = stage.rows.map((row) => name(row));
  columns.set(stage.id, [...stage.rows, ...stage.keys.map((key) => key.as), ...(stage.total ? [stage.total] : [])]);
  return `SELECT ${[...rows, ...measures].join(', ')} FROM ${quoteIdent(cteName(stage.from))}${rows.length ? ` GROUP BY ${rows.join(', ')}` : ''}`;
}

function compileBalance(stage: Rdl2BalanceStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const cols = input(columns, stage.from, stage.id);
  const name = columnResolver(cols, stage.id);
  const date = `(${name(stage.date)})::date`;
  const from = `(${expr(stage.periodFrom, ctx, name)})::date`;
  const to = `(${expr(stage.periodTo, ctx, name)})::date`;
  const inward = `COALESCE(${expr(stage.inward, ctx, name)}, 0)`;
  const outward = `COALESCE(${expr(stage.outward, ctx, name)}, 0)`;
  const keys = stage.keys.map((key) => name(key));
  const inner = `SELECT ${[
    ...keys,
    `COALESCE(SUM(${inward} - ${outward}) FILTER (WHERE ${date} < ${from}), 0) AS "opening"`,
    `COALESCE(SUM(${inward}) FILTER (WHERE ${date} BETWEEN ${from} AND ${to}), 0) AS "inward"`,
    `COALESCE(SUM(${outward}) FILTER (WHERE ${date} BETWEEN ${from} AND ${to}), 0) AS "outward"`,
  ].join(', ')} FROM ${quoteIdent(cteName(stage.from))} WHERE ${date} <= ${to}${keys.length ? ` GROUP BY ${keys.join(', ')}` : ''}`;
  columns.set(stage.id, [...stage.keys, 'opening', 'inward', 'outward', 'closing']);
  const sql = `SELECT ${[...stage.keys.map(quoteIdent), '"opening"', '"inward"', '"outward"', '("opening" + "inward" - "outward") AS "closing"'].join(', ')} FROM (${inner}) b`;
  return stage.keepZero ? sql : `${sql} WHERE NOT ("opening" = 0 AND "inward" = 0 AND "outward" = 0)`;
}

function compileClassify(stage: Rdl2ClassifyStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const cols = input(columns, stage.from, stage.id);
  const name = columnResolver(cols, stage.id);
  if (!stage.rules.length) throw new ReportCompileError('has no rules', stage.id);
  const cases = stage.rules.map((rule) => `WHEN ${expr(rule.when, ctx, name)} THEN ${ctx.binder.bind(rule.value)}`).join(' ');
  const otherwise = stage.otherwise !== undefined ? ctx.binder.bind(stage.otherwise) : 'NULL';
  const kept = cols.filter((col) => col !== stage.as);
  columns.set(stage.id, [...kept, stage.as]);
  return `SELECT ${[...kept.map(quoteIdent), `(CASE ${cases} ELSE ${otherwise} END) AS ${quoteIdent(stage.as)}`].join(', ')} FROM ${quoteIdent(cteName(stage.from))}`;
}

/** Each row once per period its date is in, with the period's name (`periods.ts`). */
function compilePeriods(stage: Rdl2PeriodsStage, ctx: ReportCompileContext, columns: Map<string, string[]>, periods: Rdl2ResolvedPeriod[]): string {
  const cols = input(columns, stage.from, stage.id);
  if (!stage.date || !cols.includes(stage.date)) throw new ReportCompileError(`has no date column "${stage.date ?? ''}" (columns: ${cols.join(', ')})`, stage.id);
  const as = stage.as || 'period';
  quoteIdent(as);
  const kept = cols.filter((col) => col !== as);
  columns.set(stage.id, [...kept, as]);
  const values = periods
    .map((period) => `(${ctx.binder.bind(period.name)}, CAST(${ctx.binder.bind(period.from)} AS date), CAST(${ctx.binder.bind(period.to)} AS date))`)
    .join(', ');
  return `SELECT ${[...kept.map((col) => `f.${quoteIdent(col)}`), `p."n" AS ${quoteIdent(as)}`].join(', ')}
FROM ${quoteIdent(cteName(stage.from))} f
INNER JOIN (VALUES ${values}) AS p("n", "pf", "pt") ON (f.${quoteIdent(stage.date)})::date BETWEEN p."pf" AND p."pt"`;
}

/**
 * A computed stage (`stages.ts`): its columns empty until the runner has worked the figures out, then joined back.
 * The stage kind checks the stage and compiles its own SQL.
 */
function compileComputed(stage: Rdl2StageBase, kind: NonNullable<ReturnType<typeof computedKind>>, ctx: ReportCompileContext, columns: Map<string, string[]>, pending: Rdl2StageBase[]): string {
  if (!stage.from) throw new ReportCompileError('names no stage to read (from)', stage.id);
  const cols = input(columns, stage.from, stage.id);
  const sql = stageSql(ctx, cols, stage.id);
  const added = kind.added(stage, cols, sql);
  for (const as of added) {
    quoteIdent(as);
    if (cols.includes(as)) throw new ReportCompileError(`already has a column "${as}"; name the added columns differently`, stage.id);
  }
  if (new Set(added).size !== added.length) throw new ReportCompileError('adds two columns with the same name', stage.id);
  columns.set(stage.id, [...cols, ...added]);
  const from = quoteIdent(cteName(stage.from));
  const json = ctx.figures?.get(stage.id);
  if (json === undefined) {
    pending.push(stage);
    return `SELECT f.*, ${added.map((c) => `NULL::numeric AS ${quoteIdent(c)}`).join(', ')} FROM ${from} f`;
  }
  return kind.joinSql(stage, from, ctx.binder.bind(json), sql);
}

/** SQL helpers for a computed stage over its input columns (alias `f`). */
export function stageSql(ctx: ReportCompileContext, cols: string[], stageId: string): StageSql {
  return {
    expr: (source) => expr(source, ctx, columnResolver(cols, stageId, 'f')),
    bind: (value) => ctx.binder.bind(value),
    quote: quoteIdent,
    schema: ctx.scope.tenantSchema,
    params: ctx.params,
  };
}

/**
 * FIFO without a loop: an inward row's open part is what its running inward total has left
 * after the key's whole outward, capped at the row's own inward. Rows that are not inward get 0.
 */
function compileFifo(stage: Rdl2FifoStage, ctx: ReportCompileContext, columns: Map<string, string[]>): string {
  const cols = input(columns, stage.from, stage.id);
  const name = columnResolver(cols, stage.id);
  const as = stage.as || 'remaining';
  quoteIdent(as);
  if (!stage.keys.length) throw new ReportCompileError('needs the columns each queue is kept per', stage.id);
  const order = orderSql(stage.order, ctx, name);
  if (!order) throw new ReportCompileError('needs an order, oldest first', stage.id);
  const partition = `PARTITION BY ${stage.keys.map((key) => name(key)).join(', ')}`;
  const inward = `GREATEST(COALESCE(${expr(stage.inward, ctx, name)}, 0), 0)`;
  const outward = `GREATEST(COALESCE(${expr(stage.outward, ctx, name)}, 0), 0)`;
  const kept = cols.filter((col) => col !== as);
  columns.set(stage.id, [...kept, as]);
  const inner = `SELECT ${[
    ...kept.map(quoteIdent),
    `${inward} AS "__in"`,
    `SUM(${inward}) OVER (${partition} ${order} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "__cumIn"`,
    `SUM(${outward}) OVER (${partition}) AS "__out"`,
  ].join(', ')} FROM ${quoteIdent(cteName(stage.from))}`;
  return `SELECT ${[...kept.map(quoteIdent), `GREATEST(0, LEAST("__in", "__cumIn" - "__out")) AS ${quoteIdent(as)}`].join(', ')} FROM (${inner}) f`;
}
