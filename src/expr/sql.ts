import { ExpressionError, parseExpression, type Ast } from './parse.js';

/**
 * The same expressions compiled to parameterized SQL (reports, `reports/`): names are resolved by the caller (a
 * stage's columns, a catalog path), literals and `@param` values become bind replacements, never text in the SQL, and
 * functions come from a fixed list. Nothing else is accepted, so a definition cannot carry SQL.
 */

/** Binds values as named replacements: `:p0`, `:p1`. One per run. */
export class SqlBinder {
  readonly replacements: Record<string, unknown> = {};
  private n = 0;
  bind(value: unknown): string {
    const key = `p${this.n++}`;
    this.replacements[key] = value;
    return `:${key}`;
  }
}

export interface SqlContext {
  /** SQL for a name, or throw `ExpressionError` for an unknown one. */
  name: (name: string) => string;
  /** Value of a parameter, already checked by the runner. */
  param: (id: string) => unknown;
  binder: SqlBinder;
  /** `under(@input)`: SQL selecting the ids of the chosen rows and every row under them, or null when none is chosen. */
  under?: (paramId: string) => string | null;
}

const DATE = (x: string) => `(${x})::date`;

/** Fixed function list: name → arity range and SQL. */
const SQL_FUNCTION_LIST: Record<string, { min: number; max: number; sql: (a: string[]) => string }> = {
  coalesce: { min: 1, max: 8, sql: (a) => `COALESCE(${a.join(', ')})` },
  nullif: { min: 2, max: 2, sql: (a) => `NULLIF(${a[0]}, ${a[1]})` },
  if: { min: 2, max: 3, sql: (a) => `(CASE WHEN ${a[0]} THEN ${a[1]} ELSE ${a[2] ?? 'NULL'} END)` },
  abs: { min: 1, max: 1, sql: (a) => `ABS(${a[0]})` },
  round: { min: 1, max: 2, sql: (a) => `ROUND((${a[0]})::numeric, ${a[1] ?? '0'})` },
  floor: { min: 1, max: 1, sql: (a) => `FLOOR(${a[0]})` },
  ceil: { min: 1, max: 1, sql: (a) => `CEIL(${a[0]})` },
  greatest: { min: 2, max: 8, sql: (a) => `GREATEST(${a.join(', ')})` },
  least: { min: 2, max: 8, sql: (a) => `LEAST(${a.join(', ')})` },
  lower: { min: 1, max: 1, sql: (a) => `LOWER((${a[0]})::text)` },
  upper: { min: 1, max: 1, sql: (a) => `UPPER((${a[0]})::text)` },
  trim: { min: 1, max: 1, sql: (a) => `TRIM((${a[0]})::text)` },
  length: { min: 1, max: 1, sql: (a) => `LENGTH((${a[0]})::text)` },
  left: { min: 2, max: 2, sql: (a) => `LEFT((${a[0]})::text, ${a[1]})` },
  right: { min: 2, max: 2, sql: (a) => `RIGHT((${a[0]})::text, ${a[1]})` },
  concat: { min: 1, max: 12, sql: (a) => `CONCAT(${a.join(', ')})` },
  text: { min: 1, max: 1, sql: (a) => `(${a[0]})::text` },
  number: { min: 1, max: 1, sql: (a) => `(NULLIF((${a[0]})::text, ''))::numeric` },
  /** A number from text that may not be one (a free-text field): empty when it is not a plain number. */
  trynumber: { min: 1, max: 1, sql: (a) => `(CASE WHEN TRIM((${a[0]})::text) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN TRIM((${a[0]})::text)::numeric END)` },
  date: { min: 1, max: 1, sql: (a) => DATE(a[0]!) },
  year: { min: 1, max: 1, sql: (a) => `EXTRACT(YEAR FROM ${DATE(a[0]!)})::int` },
  month: { min: 1, max: 1, sql: (a) => `EXTRACT(MONTH FROM ${DATE(a[0]!)})::int` },
  day: { min: 1, max: 1, sql: (a) => `EXTRACT(DAY FROM ${DATE(a[0]!)})::int` },
  weekday: { min: 1, max: 1, sql: (a) => `EXTRACT(ISODOW FROM ${DATE(a[0]!)})::int` },
  monthstart: { min: 1, max: 1, sql: (a) => `DATE_TRUNC('month', ${DATE(a[0]!)})::date` },
  monthname: { min: 1, max: 1, sql: (a) => `TO_CHAR(${DATE(a[0]!)}, 'Mon YYYY')` },
  /** Indian financial year start (1 April) of a date. */
  fystart: {
    min: 1,
    max: 1,
    sql: (a) => `MAKE_DATE((EXTRACT(YEAR FROM ${DATE(a[0]!)})::int - CASE WHEN EXTRACT(MONTH FROM ${DATE(a[0]!)}) < 4 THEN 1 ELSE 0 END), 4, 1)`,
  },
  /** Financial year label of a date: `2026-27`. */
  fy: {
    min: 1,
    max: 1,
    sql: (a) => {
      const y = `(EXTRACT(YEAR FROM ${DATE(a[0]!)})::int - CASE WHEN EXTRACT(MONTH FROM ${DATE(a[0]!)}) < 4 THEN 1 ELSE 0 END)`;
      return `(${y}::text || '-' || LPAD(((${y} + 1) % 100)::text, 2, '0'))`;
    },
  },
  daysbetween: { min: 2, max: 2, sql: (a) => `(${DATE(a[1]!)} - ${DATE(a[0]!)})` },
  adddays: { min: 2, max: 2, sql: (a) => `(${DATE(a[0]!)} + ((${a[1]})::int))` },
  today: { min: 0, max: 0, sql: () => 'CURRENT_DATE' },
};

/** Every function a formula may use; `picked` and `under` are handled apart from the list above. */
export const SQL_FUNCTIONS = [...Object.keys(SQL_FUNCTION_LIST), 'picked', 'under'];

function likeEscape(value: unknown): string {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export function expressionSql(ast: Ast, ctx: SqlContext): string {
  const s = (a: Ast) => expressionSql(a, ctx);
  switch (ast.k) {
    case 'num':
      return ctx.binder.bind(ast.v);
    case 'str':
      return ctx.binder.bind(ast.v);
    case 'bool':
      return ast.v ? 'TRUE' : 'FALSE';
    case 'null':
      return 'NULL';
    case 'name':
      return ctx.name(ast.v);
    case 'param': {
      const value = ctx.param(ast.v);
      return value === null || value === undefined ? 'NULL' : ctx.binder.bind(value);
    }
    case 'neg':
      // A negative literal binds as one value; otherwise subtract, since Sequelize does not
      // replace a placeholder written right after a minus sign.
      if (ast.v.k === 'num') return ctx.binder.bind(-ast.v.v);
      return `(0 - ${s(ast.v)})`;
    case 'not':
      return `(NOT ${s(ast.v)})`;
    case 'bin': {
      const op = ast.op === 'and' ? 'AND' : ast.op === 'or' ? 'OR' : ast.op === '!=' ? '<>' : ast.op;
      if (ast.op === '/') return `(${s(ast.l)} / NULLIF(${s(ast.r)}, 0))`;
      return `(${s(ast.l)} ${op} ${s(ast.r)})`;
    }
    case 'between':
      return `(${s(ast.v)} ${ast.not ? 'NOT ' : ''}BETWEEN ${s(ast.lo)} AND ${s(ast.hi)})`;
    case 'in': {
      if (!Array.isArray(ast.items) && ast.items.k === 'call') {
        const arg = ast.items.args[0];
        if (!ctx.under || arg?.k !== 'param') throw new ExpressionError('under() is not available here');
        const tree = ctx.under(arg.v);
        // Nothing chosen filters nothing, as for an empty list.
        if (tree === null) return 'TRUE';
        return `(${s(ast.v)} ${ast.not ? 'NOT IN' : 'IN'} (${tree}))`;
      }
      if (!Array.isArray(ast.items)) {
        const value = ast.items.k === 'param' ? ctx.param(ast.items.v) : undefined;
        const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
        // An empty list means "no choice", so it filters nothing (rather than matching nothing).
        if (list.length === 0) return 'TRUE';
        // Sequelize expands an array replacement into a value list, so it goes in IN ( ).
        return `(${s(ast.v)} ${ast.not ? 'NOT IN' : 'IN'} (${ctx.binder.bind(list)}))`;
      }
      return `(${s(ast.v)} ${ast.not ? 'NOT IN' : 'IN'} (${ast.items.map(s).join(', ')}))`;
    }
    case 'isnull':
      if (ast.empty) return ast.not ? `(COALESCE((${s(ast.v)})::text, '') <> '')` : `(COALESCE((${s(ast.v)})::text, '') = '')`;
      return `(${s(ast.v)} IS ${ast.not ? 'NOT ' : ''}NULL)`;
    case 'text': {
      if (ast.arg.k !== 'str' && ast.arg.k !== 'param') throw new ExpressionError(`${ast.op} takes a text value or a parameter`);
      const arg = ast.arg.k === 'str' ? ast.arg.v : ctx.param(ast.arg.v);
      // An empty search means "no search", as an empty choice list does for `in`.
      if (ast.arg.k === 'param' && (arg === null || arg === undefined || arg === '')) return 'TRUE';
      if (arg === null || arg === undefined) throw new ExpressionError(`${ast.op} takes a text value or a parameter`);
      const raw = likeEscape(arg);
      const pattern = ast.op === 'contains' ? `%${raw}%` : ast.op === 'starts' ? `${raw}%` : `%${raw}`;
      return `((${s(ast.v)})::text ${ast.not ? 'NOT ILIKE' : 'ILIKE'} ${ctx.binder.bind(pattern)})`;
    }
    case 'call': {
      // `picked(@input)`: whether an input has a value, so an empty choice can mean "none".
      if (ast.fn === 'picked') {
        const arg = ast.args[0];
        if (ast.args.length !== 1 || arg?.k !== 'param') throw new ExpressionError('picked() takes one input, such as picked(@groups)');
        const value = ctx.param(arg.v);
        const empty = value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
        return empty ? 'FALSE' : 'TRUE';
      }
      const fn = SQL_FUNCTION_LIST[ast.fn];
      if (!fn) throw new ExpressionError(`Unknown function ${ast.fn}()`);
      if (ast.args.length < fn.min || ast.args.length > fn.max) {
        throw new ExpressionError(`${ast.fn}() takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max}`} values`);
      }
      return fn.sql(ast.args.map(s));
    }
    default:
      throw new ExpressionError('Unsupported expression');
  }
}

/** Parse and compile in one step. */
export function compileSql(src: string, ctx: SqlContext): string {
  return expressionSql(parseExpression(src), ctx);
}
