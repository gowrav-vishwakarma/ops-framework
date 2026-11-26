import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseError, QueryTypes, Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { QueryFn } from '../crud/op-context.js';
import { ExpressionError } from '../expr/parse.js';
import { compileSql, SqlBinder } from '../expr/sql.js';
import { requireTenant } from '../tenancy/context.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { ReportCatalogService } from './catalog.js';
import { buildColumnFilterClause } from './column-filter.js';
import { compileStages, quoteIdent, ReportCompileError, stageSql, type Rdl2Compiled, type ReportScope } from './compiler.js';
import { RDL2, type Rdl2NativeStage, type Rdl2Param, type Rdl2Report, type Rdl2RunRequest, type Rdl2RunResult, type Rdl2StageBase } from './language.js';
import type { ReportRowScopeSource, ReportsConfig, ReportStore, ReportUser } from './options.js';
import { bareOutput, outputNeeds, pruneReport } from './prune.js';
import { reportLimits, RunGate, type ResolvedReportLimits } from './limits.js';
import { computedKind, nativeStage } from './stages.js';
import { groupedRunSql, type GroupedRunSql } from './summary.js';
import { REPORT_ROW_SCOPE, REPORT_STORE, REPORTS_CONFIG } from './tokens.js';

type Report = Rdl2Report<Rdl2StageBase>;

const DEFAULT_PAGE = 100;
const MAX_PAGE = 5000;
/** Keys one computed stage may work out in a run, unless its kind says otherwise. */
const MAX_KEYS = 200_000;
/** Rows an "all rows" run or a native stage may read. */
const MAX_ALL = 50000;

/** One gate for the whole process, however many runner instances there are (sized by the first). */
let GATE: RunGate | null = null;

/** Where a report came from: shipped in code (may use native stages) or user-made. */
type Origin = 'code' | 'user';

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The user's financial year: `fiscalYearStart`, else the one (from 1 April) today is in. */
function fiscalYear(user: ReportUser | undefined): { start: string; end: string } {
  const now = new Date();
  const start = /^\d{4}-\d{2}-\d{2}$/.test(user?.fiscalYearStart ?? '')
    ? user!.fiscalYearStart!
    : `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return { start, end: iso(end) };
}

/** `today`, `fyStart`, `fyEnd`, `fyToDate`, `monthStart` → a date. */
function dateWord(word: unknown, user: ReportUser | undefined): unknown {
  if (typeof word !== 'string') return word;
  const { start, end } = fiscalYear(user);
  const today = iso(new Date());
  if (word === 'today') return today;
  if (word === 'fyStart') return start;
  if (word === 'fyEnd') return end;
  if (word === 'fyToDate') return today < end ? today : end;
  if (word === 'monthStart') return `${today.slice(0, 8)}01`;
  return word;
}

/**
 * A page of whole groups from rows already in memory: groups are numbered in the order they first
 * appear, and the page holds groups `offset + 1` to `offset + limit` with all their rows.
 */
export function groupPageInMemory(rows: Record<string, unknown>[], keys: string[], offset: number, limit: number): { rows: Record<string, unknown>[]; groups: number } {
  const numbers = new Map<string, number>();
  const page: Record<string, unknown>[] = [];
  for (const row of rows) {
    const key = JSON.stringify(keys.map((column) => row[column] ?? null));
    let number = numbers.get(key);
    if (number === undefined) {
      number = numbers.size + 1;
      numbers.set(key, number);
    }
    if (number > offset && number <= offset + limit) page.push(row);
  }
  return { rows: page, groups: numbers.size };
}

/** Validate and coerce one parameter value. */
function paramValue(param: Rdl2Param, raw: unknown, user: ReportUser | undefined): unknown {
  let value = raw === undefined || raw === '' ? dateWord(param.default, user) : raw;
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) {
    if (param.required) throw new BadRequestException(`${param.label} is required`);
    return param.multi ? [] : null;
  }
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
  const idOf = (v: unknown): unknown => (v && typeof v === 'object' && 'id' in v ? (v as { id: unknown }).id : v);
  switch (param.type) {
    case 'date': {
      value = dateWord(value, user);
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) throw new BadRequestException(`${param.label} must be a date`);
      return value.slice(0, 10);
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new BadRequestException(`${param.label} must be a number`);
      return n;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1;
    case 'select': {
      const allowed = (param.options ?? []).map((option) => option.value);
      const values = list(value);
      for (const v of values) if (!allowed.includes(v as never)) throw new BadRequestException(`${param.label}: "${String(v)}" is not a choice`);
      return param.multi ? values : values[0];
    }
    case 'lookup': {
      const ids = list(value)
        .map(idOf)
        .filter((v) => typeof v === 'number' || (typeof v === 'string' && v !== ''));
      return param.multi ? ids : (ids[0] ?? null);
    }
    default:
      return typeof value === 'string' ? value.slice(0, 500) : String(value);
  }
}

/**
 * Runs reports: by name (shipped in code, then saved), by saved id, or a definition as is. Every run is read-only,
 * time-limited, and scoped to the user's company and row scope.
 */
@Injectable()
export class ReportRunner {
  private readonly limitsOf: ResolvedReportLimits;

  constructor(
    private readonly catalog: ReportCatalogService,
    private readonly tenantDb: TenantDb,
    @Inject(REPORTS_CONFIG) private readonly config: ReportsConfig,
    @Inject(REPORT_STORE) private readonly store: ReportStore,
    @Optional() @Inject(REPORT_ROW_SCOPE) private readonly rowScope?: ReportRowScopeSource,
  ) {
    this.limitsOf = reportLimits(config.limits);
    GATE ??= new RunGate(this.limitsOf.maxRuns);
  }

  /** A report shipped in code, by name. */
  shipped(name: string): Report | undefined {
    return (this.config.shipped?.() ?? []).find((report) => report.name === name);
  }

  /** The request's tenant: its connection (shard) and schema. */
  private tenant(): { db: Sequelize; schema: string } {
    const tenant = requireTenant('a report run');
    return { db: tenant.sequelize, schema: tenant.placement.schema };
  }

  /** The report a request names, and where it came from. */
  async resolve(request: Rdl2RunRequest, user: ReportUser, transaction?: Transaction): Promise<{ report: Report; origin: Origin }> {
    if (request.definition) return { report: this.check(request.definition), origin: 'user' };
    if (request.name) {
      const shipped = this.shipped(request.name);
      if (shipped) return { report: shipped, origin: 'code' };
    }
    if (!request.id && !request.name) throw new BadRequestException('Name a report, give its id, or send a definition');
    const saved = request.id ? await this.store.get(user, request.id, transaction) : await this.store.byName(user, request.name!, transaction);
    if (!saved) throw new NotFoundException('Report not found');
    if (saved.status === 'archived') throw new ForbiddenException('This report is archived');
    return { report: this.check(saved.definition), origin: 'user' };
  }

  /** A minimal shape check before compiling; the compiler checks the rest. */
  check(definition: unknown): Report {
    const report = definition as Report;
    if (!report || report.lang !== RDL2) throw new BadRequestException('This is not an RDL2 report');
    if ((definition as { kind?: unknown }).kind === 'pivot') throw new BadRequestException('This is a saved pivot; open it in the pivot');
    if (!Array.isArray(report.stages) || !Array.isArray(report.params) || !report.output?.stage) {
      throw new BadRequestException('A report needs params, stages and an output');
    }
    return report;
  }

  /** Company, and the row-scope values this user may read (`reports.rowScope`). */
  private async scope(user: ReportUser, picked: unknown[] | null, transaction?: Transaction): Promise<ReportScope> {
    const allowed = this.config.rowScope && this.rowScope ? await this.rowScope.allowed(user, transaction) : null;
    let rowIds = allowed;
    if (picked && picked.length > 0) {
      const values = picked.filter((value): value is number | string => typeof value === 'number' || (typeof value === 'string' && value !== ''));
      // A scope input narrows the scope; it never widens it.
      rowIds = allowed === null ? values : values.filter((value) => allowed.some((id) => String(id) === String(value)));
    }
    return { tenantSchema: this.tenant().schema, companyId: user.companyId, rowIds };
  }

  /**
   * `options.compute: false` leaves computed stages (`cost`, `engine`) empty instead of working them out: a save only
   * checks that the report compiles and runs, and the computed figures are the slow part.
   */
  async run(request: Rdl2RunRequest, user: ReportUser, transaction?: Transaction, options: { compute?: boolean } = {}): Promise<Rdl2RunResult> {
    const started = Date.now();
    const { report, origin } = await this.resolve(request, user, transaction);

    const params: Record<string, unknown> = {};
    let scopeInput: unknown[] | null = null;
    for (const param of report.params) {
      params[param.id] = paramValue(param, request.params?.[param.id], user);
      if (param.branchScope) {
        const value = params[param.id];
        scopeInput = (Array.isArray(value) ? value : [value]).filter((v) => v !== null && v !== undefined);
      }
    }
    const scope = await this.scope(user, scopeInput, transaction);
    let binder = new SqlBinder();

    const last = report.stages[report.stages.length - 1];
    const native = last?.kind === 'native' ? (last as Rdl2NativeStage) : null;
    if (native && origin !== 'code') throw new BadRequestException('Only reports shipped with the system may use native stages');
    const shippedOnly = origin === 'code' ? undefined : report.stages.find((stage) => computedKind(stage.kind)?.shippedOnly);
    if (shippedOnly) throw new BadRequestException(`Only reports shipped with the system may use ${shippedOnly.kind} stages`);
    const previewing = request.previewStage;
    const sqlStages = native && !previewing ? { ...report, stages: report.stages.slice(0, -1) } : report;
    let plan = sqlStages;

    // Figures of computed stages, once worked out. Each pass compiles with a fresh binder.
    const figures = new Map<string, string>();
    const compile = (): Rdl2Compiled => {
      try {
        return compileStages(plan, { catalog: this.catalog.catalog(), scope, params, binder, figures }, previewing);
      } catch (error) {
        if (error instanceof ReportCompileError) throw new BadRequestException(error.message);
        throw error;
      }
    };
    let compiled = compile();

    const outputId = previewing ?? (native ? native.from ?? '' : report.output.stage);
    if (!compiled.columns.has(outputId)) throw new BadRequestException(`Output stage "${outputId}" is not defined`);
    // Work out only what the run shows (`request.columns`, else the output's columns) and what that
    // reads: the whole report compiled above, so it is checked before anything is taken out.
    const grouping = previewing || native ? undefined : request.summary;
    const layout = request.bare || grouping ? bareOutput(report.output) : report.output;
    // A grouped run works out its keys and values only.
    const shown = grouping ? { ...request, columns: [...grouping.keys.map((key) => key.column), ...grouping.values] } : request;
    const needed = previewing || native ? null : outputNeeds(layout, shown, compiled.columns.get(outputId)!);
    if (needed) {
      plan = pruneReport(sqlStages, needed, compiled.columns);
      binder = new SqlBinder();
      compiled = compile();
    }
    const outCols = compiled.columns.get(outputId)!;

    const { db } = this.tenant();
    const config = this.limitsOf;
    const limits = async (t: Transaction): Promise<void> => {
      await db.query(`SET LOCAL statement_timeout = ${config.timeoutMs}`, { transaction: t });
      // Opt-in (`limits.workMem`): more sort memory for this transaction only, never less than the server gives.
      if (config.workMem) {
        await db.query("SELECT set_config('work_mem', :workMem, true) WHERE pg_size_bytes(current_setting('work_mem')) < :workMemBytes", {
          replacements: { workMem: config.workMem.text, workMemBytes: config.workMem.bytes },
          transaction: t,
        });
      }
    };
    const exec = <T>(fn: (t: Transaction) => Promise<T>): Promise<T> =>
      GATE!.run(
        config.timeoutMs,
        () => new ServiceUnavailableException('Many reports are running; try again in a moment'),
        async () => {
          // Inside the caller's transaction a READ ONLY switch is too late; the limits still apply.
          if (transaction) {
            await limits(transaction);
            return fn(transaction);
          }
          // The tenant's transaction (its shard, `search_path` its schema), made read-only.
          return this.tenantDb.tx(async (t: Transaction) => {
            await db.query('SET TRANSACTION READ ONLY', { transaction: t });
            await limits(t);
            await db.query('SET LOCAL jit = off', { transaction: t });
            return fn(t);
          });
        },
      ).catch((error: unknown) => {
        // The database's own words (`character varying * numeric`), so the designer and its AI can fix the step.
        if (error instanceof DatabaseError) throw new BadRequestException(`The report could not run: ${error.message}`);
        throw error;
      });

    // Computed stages (`stages.ts`): read the keys each one receives, let its kind work the figures out in code, and
    // compile again with them in the SQL. Stages after it then run as usual.
    while (options.compute !== false && compiled.pending.length) {
      const stage = compiled.pending[0]!;
      if (figures.has(stage.id)) break;
      const kind = computedKind(stage.kind)!;
      const max = kind.maxKeys ?? MAX_KEYS;
      const chain = { withSql: compiled.withSql, from: compiled.cte(stage.from!) };
      const sql = stageSql({ catalog: this.catalog.catalog(), scope, params, binder }, compiled.columns.get(stage.from!) ?? [], stage.id);
      const keysSql = kind.keysSql(stage, chain, sql);
      const replacements = { ...binder.replacements, companyId: scope.companyId, ...kind.bindings?.(stage, params) };
      const worked = await exec(async (t) => {
        // One more than the limit is enough to refuse: the keys past it are never read.
        const keys = await db.query<Record<string, unknown>>(`SELECT * FROM (${keysSql}) stage_keys LIMIT ${max + 1}`, { replacements, type: QueryTypes.SELECT, transaction: t });
        if (keys.length > max) throw new BadRequestException(`Step ${stage.id} would work out more than ${max.toLocaleString()} rows. Narrow the period or the filters.`);
        const query: QueryFn = <T>(text: string, values?: Record<string, unknown> | unknown[]) =>
          db.query<T & object>(text, { replacements: Array.isArray(values) ? values : { ...replacements, ...values }, type: QueryTypes.SELECT, transaction: t }) as Promise<T[]>;
        return kind.work(keys, { stage, user, companyId: scope.companyId, params, t, sql: query, chain: { ...chain, replacements }, schema: scope.tenantSchema, db });
      });
      figures.set(stage.id, JSON.stringify(worked));
      binder = new SqlBinder();
      compiled = compile();
    }

    // Native stage: read its input (capped), let the code shape the rows, then page in memory.
    if (native && !previewing) {
      // One more than the cap tells a cut input from a complete one (it was cut silently).
      const fetched = await exec((t) =>
        db.query<Record<string, unknown>>(`${compiled.withSql}\nSELECT * FROM ${compiled.cte(outputId)} LIMIT ${MAX_ALL + 1}`, {
          replacements: binder.replacements,
          type: QueryTypes.SELECT,
          transaction: t,
        }),
      );
      const truncated = fetched.length > MAX_ALL;
      const rows = truncated ? fetched.slice(0, MAX_ALL) : fetched;
      const stage = nativeStage(native.name);
      if (!stage) throw new BadRequestException(`Unknown native stage "${native.name}"`);
      const shaped = await stage(rows, { params, args: native.args ?? {}, user });
      const offset = Math.max(0, Math.floor(request.offset ?? 0));
      const limit = this.limit(request, report);
      const keys = limit ? this.pageKeys(report.output, new Set(Object.keys(shaped[0] ?? {}))) : null;
      const paged = keys ? groupPageInMemory(shaped, keys, offset, limit) : null;
      return {
        columns: this.columnsOf(report, Object.keys(shaped[0] ?? {})),
        rows: paged ? paged.rows : limit ? shaped.slice(offset, offset + limit) : shaped,
        count: shaped.length,
        ...(paged ? { groups: paged.groups } : {}),
        totals: this.totalsInMemory(report, shaped),
        meta: { ms: Date.now() - started, report: report.name, ...(truncated ? { truncated: true } : {}), ...(compiled.periods.length ? { periods: compiled.periods } : {}) },
      };
    }

    const output = previewing ? null : layout;
    const known = new Set<string>(outCols);
    const filterSql = buildColumnFilterClause(
      request.where,
      (field) => (known.has(field) && (output?.columns.find((c) => c.column === field)?.filterable ?? true) ? quoteIdent(field) : null),
      binder.replacements,
    );
    const sortList = (request.sort?.length ? request.sort : output?.sort ?? []).filter((item) => known.has(item.column));
    const groups = (output?.groups ?? []).filter((group) => known.has(group.column));
    const order = [...groups.map((group) => ({ column: group.column, dir: 'asc' as const })), ...sortList];
    const orderSql = order.length ? `ORDER BY ${order.map((item) => `${quoteIdent(item.column)} ${item.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`).join(', ')}` : '';
    const limit = this.limit(request, report);
    const offset = Math.max(0, Math.floor(request.offset ?? 0));
    const filtered = `SELECT * FROM ${compiled.cte(outputId)}${filterSql ? ` WHERE ${filterSql}` : ''}`;

    // Grouped for a pivot: one row per group, ordered by the keys, a page of groups at a time.
    if (grouping) {
      const formats = new Map(report.output.columns.map((column) => [column.column, column.format]));
      let grouped: GroupedRunSql;
      try {
        grouped = groupedRunSql(filtered, grouping, known, formats, { limit: limit || MAX_ALL, offset });
      } catch (error) {
        if (error instanceof ReportCompileError) throw new BadRequestException(error.message);
        throw error;
      }
      const rows = await exec((t) => db.query<Record<string, unknown>>(`${compiled.withSql}\n${grouped.sql}`, { replacements: binder.replacements, type: QueryTypes.SELECT, transaction: t }));
      const count = Number(rows[0]?.__total ?? 0);
      for (const row of rows) delete row.__total;
      return {
        columns: this.columnsOf(report, grouped.columns),
        rows,
        count,
        totals: null,
        meta: { ms: Date.now() - started, report: report.name, ...(compiled.periods.length ? { periods: compiled.periods } : {}) },
      };
    }

    // One query: the page, with the row count, the totals and each group's subtotals as window
    // sums over the whole filtered result, so the report is worked out once, not once per figure.
    const totalsCols = this.summed(output).filter((col) => known.has(col));
    // A column's total can be a formula over the other columns' totals (GP % = gp / sales * 100),
    // worked out from the sums, never summed itself. Group subtotals and footer lines use it too.
    const formulas = new Map((output?.columns ?? []).filter((col) => col.total?.trim() && known.has(col.column)).map((col) => [col.column, col.total!]));
    const figureCols = [...new Set([...totalsCols, ...formulas.keys()])];
    const plain = (name: string): string => {
      if (!known.has(name)) throw new BadRequestException(`A total or footer names "${name}", which is not a column of the output`);
      return quoteIdent(name);
    };
    const paramOf = (id: string): unknown => {
      if (!(id in params)) throw new BadRequestException(`Unknown parameter @${id}`);
      return params[id];
    };
    /** SQL for one figure: a column's sum, or its formula over sums; `filter` limits the rows, `over` makes it a window. */
    const figure = (col: string, over: string, filter?: string): string => {
      const sum = (name: string) => `SUM(${plain(name)})${filter ? ` FILTER (WHERE ${filter})` : ''}${over}`;
      const formula = formulas.get(col);
      if (!formula) return sum(col);
      try {
        return compileSql(formula, { name: sum, param: paramOf, binder });
      } catch (error) {
        if (error instanceof ExpressionError) throw new BadRequestException(`Total of ${col}: ${error.message}`);
        throw error;
      }
    };
    // Lines under the totals, each over the rows its condition keeps (all without one product type).
    const isSet = (id: string | undefined): boolean => {
      if (!id) return true;
      const value = params[id];
      return !(value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0));
    };
    const footers = (output?.footers ?? []).flatMap((footer, index) => {
      if (!isSet(footer.needs)) return [];
      let where: string | undefined;
      try {
        where = footer.where?.trim() ? compileSql(footer.where, { name: plain, param: paramOf, binder }) : undefined;
      } catch (error) {
        if (error instanceof ExpressionError) throw new BadRequestException(`Footer "${footer.label}": ${error.message}`);
        throw error;
      }
      return [{ index, label: footer.label, where }];
    });
    const levels = groups
      .map((group, depth) => ({
        column: group.column,
        depth,
        keys: groups.slice(0, depth + 1).map((g) => g.column),
        cols: [...new Set([...(group.subtotals ?? totalsCols), ...formulas.keys()])].filter((col) => known.has(col)),
      }))
      .filter((level) => level.cols.length > 0);
    const windows = [
      'COUNT(*) OVER () AS "__total"',
      ...figureCols.map((col) => `${figure(col, ' OVER ()')} AS ${quoteIdent(`__t_${col}`)}`),
      ...footers.flatMap((footer) => figureCols.map((col) => `${figure(col, ' OVER ()', footer.where)} AS ${quoteIdent(`__f${footer.index}_${col}`)}`)),
      ...levels.flatMap((level) => {
        const over = ` OVER (PARTITION BY ${level.keys.map(quoteIdent).join(', ')})`;
        return [
          ...level.cols.map((col) => `${figure(col, over)} AS ${quoteIdent(`__g${level.depth}_${col}`)}`),
          `COUNT(*)${over} AS ${quoteIdent(`__g${level.depth}__rows`)}`,
        ];
      }),
    ];
    // Paged by group: each row gets its group's number in the report's order, and the page keeps
    // groups offset+1 to offset+limit whole. The other windows still run over the whole result.
    const pageKeys = limit ? this.pageKeys(output, known) : null;
    const keyOrder = (pageKeys ?? []).map((column) => `${quoteIdent(column)} ASC NULLS LAST`).join(', ');
    const windowed = `SELECT *, ${[...windows, ...(pageKeys ? [`DENSE_RANK() OVER (ORDER BY ${keyOrder}) AS "__gno"`] : [])].join(', ')} FROM (${filtered}) r`;
    const pageSql = pageKeys
      ? `${compiled.withSql}\nSELECT * FROM (SELECT *, MAX("__gno") OVER () AS "__groups" FROM (${windowed}) w) p WHERE "__gno" > ${offset} AND "__gno" <= ${offset + limit} ${orderSql} LIMIT ${MAX_ALL + 1}`
      : `${compiled.withSql}\n${windowed} ${orderSql} LIMIT ${limit || MAX_ALL} OFFSET ${offset}`;
    // Only when the page is past the end: the count and totals still describe the whole result.
    const summarySql = `${compiled.withSql}\nSELECT ${[
      'COUNT(*) AS "__total"',
      ...figureCols.map((col) => `${figure(col, '')} AS ${quoteIdent(col)}`),
      ...footers.flatMap((footer) => figureCols.map((col) => `${figure(col, '', footer.where)} AS ${quoteIdent(`__f${footer.index}_${col}`)}`)),
      ...(pageKeys ? [`(SELECT COUNT(*) FROM (SELECT 1 FROM (${filtered}) g GROUP BY ${pageKeys.map(quoteIdent).join(', ')}) n) AS "__groups"`] : []),
    ].join(', ')} FROM (${filtered}) r`;

    const { rows: fetched, summary } = await exec(async (t) => {
      const page = await db.query<Record<string, unknown>>(pageSql, { replacements: binder.replacements, type: QueryTypes.SELECT, transaction: t });
      const fallback =
        page.length === 0 && offset > 0
          ? ((await db.query<Record<string, unknown>>(summarySql, { replacements: binder.replacements, type: QueryTypes.SELECT, transaction: t }))[0] ?? null)
          : null;
      return { rows: page, summary: fallback };
    });
    // A page of whole groups can be large; past the cap it is cut, and says so.
    const truncated = pageKeys ? fetched.length > MAX_ALL : !limit && Number(fetched[0]?.__total ?? 0) > fetched.length;
    const rows = pageKeys && truncated ? fetched.slice(0, MAX_ALL) : fetched;

    const first = rows[0];
    const count = Number(first?.__total ?? summary?.__total ?? 0);
    const groupCount = pageKeys ? Number(first?.__groups ?? summary?.__groups ?? 0) : undefined;
    let totals: Record<string, unknown> | null = null;
    if (figureCols.length) {
      totals = {};
      for (const col of figureCols) totals[col] = first ? first[`__t_${col}`] : (summary?.[col] ?? null);
    }
    const footerLines = footers.map((footer) => {
      const line: Record<string, unknown> = { __label: footer.label };
      for (const col of figureCols) line[col] = (first ?? summary)?.[`__f${footer.index}_${col}`] ?? null;
      return line;
    });
    // Subtotals of the groups on this page, the ones the viewer draws heads for.
    const groupTotals: Record<string, Record<string, unknown>[]> = {};
    for (const level of levels) {
      const seen = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const key = JSON.stringify(level.keys.map((col) => row[col] ?? null));
        if (seen.has(key)) continue;
        const sums: Record<string, unknown> = {};
        for (const col of level.keys) sums[col] = row[col];
        for (const col of level.cols) sums[col] = row[`__g${level.depth}_${col}`];
        sums.__rows = row[`__g${level.depth}__rows`];
        seen.set(key, sums);
      }
      groupTotals[level.column] = [...seen.values()];
    }
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (key === '__total' || key === '__gno' || key === '__groups' || key.startsWith('__t_') || /^__[gf]\d+_/.test(key)) delete row[key];
      }
    }
    return {
      columns: previewing ? outCols.map((name) => ({ name, label: name })) : this.columnsOf(report, outCols),
      rows,
      count,
      ...(groupCount !== undefined ? { groups: groupCount } : {}),
      totals:
        totals || Object.keys(groupTotals).length || footerLines.length
          ? { ...totals, __groups: groupTotals, ...(footerLines.length ? { __footers: footerLines } : {}) }
          : null,
      meta: {
        ms: Date.now() - started,
        report: report.name,
        ...(previewing ? { stage: previewing } : {}),
        ...(truncated ? { truncated: true } : {}),
        ...(compiled.periods.length ? { periods: compiled.periods } : {}),
      },
    };
  }

  /**
   * Choices for a lookup parameter: rows of a catalog model whose label field contains the query.
   * Built as a one-stage report, so company, row-scope and soft-delete scoping apply as for any run.
   */
  async lookup(
    request: { model: string; label: string; value?: string; query?: string; limit?: number },
    user: ReportUser,
  ): Promise<{ rows: { value: unknown; label: unknown }[] }> {
    const value = request.value ?? 'id';
    const definition: Report = {
      lang: RDL2,
      name: 'lookup',
      title: 'Lookup',
      params: [{ id: 'q', label: 'Search', type: 'text' }],
      stages: [
        {
          kind: 'source',
          id: 'choices',
          model: request.model,
          fields: [
            { as: 'value', path: value },
            { as: 'label', path: request.label },
          ],
          ...(request.query?.trim() ? { where: `${request.label} contains @q` } : {}),
        },
      ],
      output: { stage: 'choices', columns: [], sort: [{ column: 'label' }] },
    };
    const result = await this.run(
      { definition, params: { q: request.query?.trim() ?? '' }, limit: Math.min(50, Math.max(1, request.limit ?? 20)) },
      user,
    );
    return { rows: result.rows.map((row) => ({ value: row.value, label: row.label })) };
  }

  /**
   * The group columns a page is cut on when the report pages by group: the groups down to and
   * including `pageBy`. Null when it pages by row, or `pageBy` is not one of its groups.
   */
  private pageKeys(output: Report['output'] | null, known: Set<string>): string[] | null {
    if (!output?.pageBy) return null;
    const groups = (output.groups ?? []).map((group) => group.column).filter((column) => known.has(column));
    const level = groups.indexOf(output.pageBy);
    return level < 0 ? null : groups.slice(0, level + 1);
  }

  /** Rows a page holds. A pivot's run (bare or grouped) takes batches up to the "all rows" cap. */
  private limit(request: Rdl2RunRequest, report: Report): number {
    const wanted = request.limit ?? report.output.pageSize ?? DEFAULT_PAGE;
    if (wanted === 0) return 0;
    return Math.min(request.bare || request.summary ? MAX_ALL : MAX_PAGE, Math.max(1, Math.floor(wanted)));
  }

  private columnsOf(report: Report, available: string[]) {
    const declared = report.output.columns.filter((c) => available.includes(c.column));
    if (!declared.length) return available.map((name) => ({ name, label: name }));
    return declared.map((c) => ({ name: c.column, label: c.label, ...(c.format ? { format: c.format } : {}) }));
  }

  /** Columns summed over the whole result: the totals line's and the cards'. */
  private summed(output: Report['output'] | null): string[] {
    if (!output) return [];
    return [...new Set([...(output.totals ?? []), ...(output.cards ?? []).map((card) => card.column)])];
  }

  private totalsInMemory(report: Report, rows: Record<string, unknown>[]): Record<string, unknown> | null {
    const cols = this.summed(report.output);
    if (!cols.length) return null;
    const out: Record<string, unknown> = {};
    for (const col of cols) out[col] = rows.reduce((sum, row) => sum + (Number(row[col]) || 0), 0);
    return out;
  }
}
