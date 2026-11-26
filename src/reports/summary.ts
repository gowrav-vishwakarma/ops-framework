import { quoteIdent, ReportCompileError } from './compiler.js';
import type { Rdl2ColumnFormat, Rdl2DateBucket, Rdl2RunSummary } from './language.js';

/**
 * A grouped run for a pivot (`request.summary`): the report's rows grouped by the pivot's keys,
 * with what each value needs, so a pivot of 100,000 lines by month and voucher type reads a few
 * hundred rows. See `Rdl2RunSummary` for the columns.
 */

const NUMERIC = new Set<Rdl2ColumnFormat>(['money', 'qty', 'number', 'percent']);
const DATES = new Set<Rdl2ColumnFormat>(['date', 'datetime']);

/** A date grouped to the first day of its bucket. The financial year starts in April, as the runner's date words. */
function bucketSql(column: string, bucket: Rdl2DateBucket): string {
  const day = `(${column})::date`;
  if (bucket === 'fy') return `(date_trunc('year', ${day} - interval '3 months') + interval '3 months')::date`;
  return `date_trunc('${bucket}', ${day})::date`;
}

export interface GroupedRunSql {
  /** SELECT over `fromSql`: one row per group, with the window count of groups as `__total`. */
  sql: string;
  /** Columns the run must work out: the keys and the values. */
  columns: string[];
}

/**
 * The grouped SELECT over `fromSql` (the report's filtered rows). Keys and values must be output
 * columns (`known`); `formats` says which are numbers (summed) and dates (bucketed).
 */
export function groupedRunSql(
  fromSql: string,
  summary: Rdl2RunSummary,
  known: ReadonlySet<string>,
  formats: ReadonlyMap<string, Rdl2ColumnFormat | undefined>,
  page: { limit: number; offset: number },
): GroupedRunSql {
  const missing = [...summary.keys.map((key) => key.column), ...summary.values].filter((column) => !known.has(column));
  if (missing.length)
    throw new ReportCompileError(`The pivot asks for columns the report does not have: ${missing.join(', ')}`);
  const keys = [...new Map(summary.keys.map((key) => [key.column, key])).values()];
  const keyNames = new Set(keys.map((key) => key.column));
  const values = [...new Set(summary.values)].filter((column) => !keyNames.has(column));
  const keySelect = keys.map((key) => {
    const col = quoteIdent(key.column);
    const format = formats.get(key.column);
    if (!key.bucket || !format || !DATES.has(format)) return { expr: col, as: col };
    if (!['month', 'quarter', 'fy', 'year'].includes(key.bucket))
      throw new ReportCompileError(`"${String(key.bucket)}" is not a date grouping`);
    return { expr: bucketSql(col, key.bucket), as: col };
  });
  const measures = values.flatMap((column) => {
    const col = quoteIdent(column);
    const count = `COUNT(${col}) AS ${quoteIdent(`${column}__n`)}`;
    const format = formats.get(column);
    if (!format || !NUMERIC.has(format)) return [count];
    return [
      `SUM(${col}) AS ${col}`,
      count,
      `MIN(${col}) AS ${quoteIdent(`${column}__min`)}`,
      `MAX(${col}) AS ${quoteIdent(`${column}__max`)}`,
    ];
  });
  const select = [...keySelect.map((key) => `${key.expr} AS ${key.as}`), 'COUNT(*) AS "__rows"', ...measures].join(
    ', ',
  );
  const group = keySelect.length ? ` GROUP BY ${keySelect.map((_key, index) => index + 1).join(', ')}` : '';
  // Ordered by every key, so each group has one place and pages never overlap or skip.
  const order = keySelect.length ? ` ORDER BY ${keySelect.map((key) => `${key.as} ASC NULLS LAST`).join(', ')}` : '';
  const limit = Math.max(1, Math.floor(page.limit));
  const offset = Math.max(0, Math.floor(page.offset));
  return {
    sql: `SELECT *, COUNT(*) OVER () AS "__total" FROM (SELECT ${select} FROM (${fromSql}) r${group}) g${order} LIMIT ${limit} OFFSET ${offset}`,
    columns: [...keys.map((key) => key.column), ...values],
  };
}
