import { ReportCompileError } from './compiler.js';
import type { Rdl2PeriodsStage } from './language.js';

/** A period of a `periods` stage once its dates are known. */
export interface Rdl2ResolvedPeriod {
  stage: string;
  name: string;
  label: string;
  from: string;
  to: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(day: string): [number, number, number] {
  return [Number(day.slice(0, 4)), Number(day.slice(5, 7)), Number(day.slice(8, 10))];
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isMonthEnd(day: string): boolean {
  const [y, m, d] = parts(day);
  return d === daysIn(y, m);
}

/** `day` moved by `months`; a day past the new month's end becomes its last day (31 Mar − 1 month = 28/29 Feb). */
export function addMonths(day: string, months: number, keepMonthEnd = false): string {
  const [y, m, d] = parts(day);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = daysIn(year, month);
  return iso(year, month, keepMonthEnd ? last : Math.min(d, last));
}

function addDays(day: string, days: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((day) => Date.UTC(...(parts(day).map((n, i) => (i === 1 ? n - 1 : n)) as [number, number, number])));
  return Math.round((b! - a!) / 86_400_000);
}

/** A period moved by whole months: a period ending on a month's last day keeps ending on one. */
function shiftBy(from: string, to: string, months: number): [string, string] {
  return [addMonths(from, months), addMonths(to, months, isMonthEnd(to))];
}

/** The period of the same length just before: whole months stay whole months (Q2 → Q1), else days. */
function previous(from: string, to: string): [string, string] {
  const [fy, fm, fd] = parts(from);
  const [ty, tm] = parts(to);
  if (fd === 1 && isMonthEnd(to)) return shiftBy(from, to, -((ty - fy) * 12 + (tm - fm) + 1));
  const length = daysBetween(from, to) + 1;
  return [addDays(from, -length), addDays(from, -1)];
}

function dateParam(text: string, params: Record<string, unknown>, stage: string, what: string): string {
  const param = /^@([A-Za-z_]\w*)$/.exec(text.trim());
  const value = param ? params[param[1]!] : text.trim();
  const day = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!ISO.test(day)) throw new ReportCompileError(`${what} must be a date input such as @from, or a date`, stage);
  return day;
}

/** Indian financial year of a day: `2026-27` (April start). */
function fyOf(day: string): string {
  const [y, m] = parts(day);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function shown(day: string): string {
  const [y, m, d] = parts(day);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * A period's heading. Words in braces are filled in: `{from}` and `{to}` (1 Apr 2026), `{fromMonth}`
 * and `{toMonth}` (Aug-26), `{fy}` (2026-27, of the start), `{year}` (of the end). Default "{from} to {to}".
 */
export function periodLabel(template: string | undefined, from: string, to: string): string {
  const month = (day: string) => `${MONTHS[parts(day)[1] - 1]}-${day.slice(2, 4)}`;
  const words: Record<string, string> = {
    from: shown(from),
    to: shown(to),
    fromMonth: month(from),
    toMonth: month(to),
    fy: fyOf(from),
    year: to.slice(0, 4),
  };
  return (template?.trim() || '{from} to {to}').replace(/\{(\w+)\}/g, (all, word: string) => words[word] ?? all);
}

const MAX_PERIODS = 24;

/** Every period a stage defines, in order, with its dates and heading. A `repeat` makes name1, name2, … */
export function resolvePeriods(stage: Rdl2PeriodsStage, params: Record<string, unknown>): Rdl2ResolvedPeriod[] {
  const baseFrom = dateParam(stage.periodFrom, params, stage.id, 'The period start');
  const baseTo = dateParam(stage.periodTo, params, stage.id, 'The period end');
  if (baseTo < baseFrom) throw new ReportCompileError('The period ends before it starts', stage.id);
  if (!stage.periods?.length) throw new ReportCompileError('needs at least one period', stage.id);
  const out: Rdl2ResolvedPeriod[] = [];
  for (const spec of stage.periods) {
    if (!/^[A-Za-z_]\w*$/.test(spec.name ?? '')) throw new ReportCompileError('A period name uses letters, digits and _', stage.id);
    const months = (spec.shiftYears ?? 0) * 12 + (spec.shiftMonths ?? 0);
    const repeat = Math.max(1, Math.min(MAX_PERIODS, Math.floor(spec.repeat ?? 1)));
    let [from, to] = [baseFrom, baseTo];
    for (let step = 1; step <= repeat; step += 1) {
      if (spec.previous) [from, to] = previous(from, to);
      else if (months) [from, to] = shiftBy(baseFrom, baseTo, months * step);
      out.push({ stage: stage.id, name: spec.repeat ? `${spec.name}${step}` : spec.name, label: periodLabel(spec.label, from, to), from, to });
      if (!spec.previous && !months) break;
    }
  }
  if (out.length > MAX_PERIODS) throw new ReportCompileError(`A stage has at most ${MAX_PERIODS} periods`, stage.id);
  const names = new Set<string>();
  for (const period of out) {
    if (names.has(period.name)) throw new ReportCompileError(`Two periods are named "${period.name}"`, stage.id);
    names.add(period.name);
  }
  return out;
}

/** The inputs a periods stage adds for earlier stages: `@<id>_from` and `@<id>_to`, the span of all its periods. */
export function periodSpanParams(periods: Rdl2ResolvedPeriod[], stageId: string): Record<string, string> {
  const from = periods.reduce((min, period) => (period.from < min ? period.from : min), periods[0]!.from);
  const to = periods.reduce((max, period) => (period.to > max ? period.to : max), periods[0]!.to);
  return { [`${stageId}_from`]: from, [`${stageId}_to`]: to };
}
