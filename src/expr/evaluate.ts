import { ExpressionError, parseExpression, type Ast } from './parse.js';

/** Where an expression's names and `@params` come from. */
export interface ExpressionScope {
  /** The value of a dotted name (`data.name`, `lookup.id`); undefined when absent. */
  name(path: string): unknown;
  param?(id: string): unknown;
}

export interface ExpressionFunction {
  min: number;
  max: number;
  run(args: unknown[]): unknown;
}

const isNull = (value: unknown) => value === null || value === undefined;

/** Postgres DECIMAL arrives as a string: numeric text on one side of a number compares as a number. */
function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // Decimal text only (Postgres refuses '0x10', '0b11', 'Infinity').
  if (typeof value === 'string' && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(value)) return Number(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

function dateOf(value: unknown): Date | null {
  if (isNull(value) || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value).length === 10 ? `${String(value)}T00:00:00Z` : String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);
const fyStartYear = (date: Date) => date.getUTCFullYear() - (date.getUTCMonth() < 3 ? 1 : 0);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** -1, 0, 1, or null when either side is null (SQL: the comparison is unknown). */
function compare(a: unknown, b: unknown): number | null {
  if (isNull(a) || isNull(b)) return null;
  const [na, nb] = [numeric(a), numeric(b)];
  if (na !== null && nb !== null && (typeof a === 'number' || typeof b === 'number' || (typeof a === 'string' && typeof b === 'string' && na === Number(a) && nb === Number(b) && /^-?\d/.test(a) && /^-?\d/.test(b)))) {
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (a instanceof Date || b instanceof Date) {
    const [da, db] = [dateOf(a), dateOf(b)];
    if (da && db) return da.getTime() === db.getTime() ? 0 : da < db ? -1 : 1;
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b) ? 0 : Boolean(a) ? 1 : -1;
  const [sa, sb] = [String(a), String(b)];
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** SQL truth: null stays unknown. */
const truth = (value: unknown): boolean | null => (isNull(value) ? null : Boolean(value));

/** `path` of one list item (`'qty'`, `'batch.id'`), through plain objects and model instances. */
function pick(item: unknown, path: unknown): unknown {
  let value = item;
  for (const key of String(path ?? '').split('.').filter(Boolean)) {
    if (value === null || value === undefined) return null;
    const get = (value as { get?: (k: string) => unknown }).get;
    // Own fields only: never `constructor`, `__proto__` or other inherited JavaScript internals.
    value = typeof get === 'function' ? get.call(value, key) : typeof value === 'object' && Object.hasOwn(value as object, key) ? (value as Record<string, unknown>)[key] : undefined;
  }
  return value ?? null;
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : isNull(value) ? [] : [value]);
/** Items of a list, or the values at `path` of each item. */
const valuesOf = (items: unknown, path?: unknown): unknown[] => (path === undefined ? list(items) : list(items).map((item) => pick(item, path)));
const sameKey = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

const FUNCTIONS = new Map<string, ExpressionFunction>(
  Object.entries<ExpressionFunction>({
    coalesce: { min: 1, max: 12, run: (a) => a.find((v) => !isNull(v)) ?? null },
    /** The first value that is set and not empty, zero or false (JavaScript's `a || b`), else the last. */
    either: { min: 2, max: 12, run: (a) => a.find((v) => Boolean(v)) ?? a[a.length - 1] ?? null },
    nullif: { min: 2, max: 2, run: ([a, b]) => (compare(a, b) === 0 ? null : a) },
    if: { min: 2, max: 3, run: ([c, a, b]) => (truth(c) ? a : (b ?? null)) },
    abs: { min: 1, max: 1, run: ([a]) => (numeric(a) === null ? null : Math.abs(numeric(a)!)) },
    round: {
      min: 1,
      max: 2,
      // Half away from zero on the decimal digits, as Postgres numeric does (4.015 -> 4.02, -2.5 -> -3).
      run: ([a, d]) => {
        const n = numeric(a);
        if (n === null) return null;
        const places = Math.trunc(numeric(d) ?? 0);
        const abs = Math.abs(n);
        const shifted = String(abs).includes('e') ? abs * 10 ** places : Number(`${abs}e${places}`);
        const rounded = Math.round(shifted);
        const back = String(rounded).includes('e') ? rounded / 10 ** places : Number(`${rounded}e${-places}`);
        return Math.sign(n) * back || 0;
      },
    },
    floor: { min: 1, max: 1, run: ([a]) => (numeric(a) === null ? null : Math.floor(numeric(a)!)) },
    ceil: { min: 1, max: 1, run: ([a]) => (numeric(a) === null ? null : Math.ceil(numeric(a)!)) },
    greatest: { min: 2, max: 12, run: (a) => a.filter((v) => !isNull(v)).reduce<unknown>((m, v) => (m === undefined || (compare(v, m) ?? 0) > 0 ? v : m), undefined) ?? null },
    least: { min: 2, max: 12, run: (a) => a.filter((v) => !isNull(v)).reduce<unknown>((m, v) => (m === undefined || (compare(v, m) ?? 0) < 0 ? v : m), undefined) ?? null },
    lower: { min: 1, max: 1, run: ([a]) => (isNull(a) ? null : String(a).toLowerCase()) },
    upper: { min: 1, max: 1, run: ([a]) => (isNull(a) ? null : String(a).toUpperCase()) },
    trim: { min: 1, max: 1, run: ([a]) => (isNull(a) ? null : String(a).trim()) },
    length: { min: 1, max: 1, run: ([a]) => (isNull(a) ? null : Array.isArray(a) ? a.length : String(a).length) },
    left: { min: 2, max: 2, run: ([a, n]) => (isNull(a) ? null : String(a).slice(0, numeric(n) ?? 0)) },
    right: { min: 2, max: 2, run: ([a, n]) => (isNull(a) ? null : String(a).slice(-(numeric(n) ?? 0) || String(a).length)) },
    concat: { min: 1, max: 12, run: (a) => a.map((v) => (isNull(v) ? '' : String(v))).join('') },
    text: { min: 1, max: 1, run: ([a]) => (isNull(a) ? null : a instanceof Date ? a.toISOString() : String(a)) },
    number: { min: 1, max: 1, run: ([a]) => (isNull(a) || a === '' ? null : numeric(a)) },
    trynumber: { min: 1, max: 1, run: ([a]) => (typeof a === 'string' && /^-?[0-9]+(\.[0-9]+)?$/.test(a.trim()) ? Number(a.trim()) : typeof a === 'number' ? a : null) },
    date: { min: 1, max: 1, run: ([a]) => (dateOf(a) ? isoDay(dateOf(a)!) : null) },
    year: { min: 1, max: 1, run: ([a]) => dateOf(a)?.getUTCFullYear() ?? null },
    month: { min: 1, max: 1, run: ([a]) => (dateOf(a) ? dateOf(a)!.getUTCMonth() + 1 : null) },
    day: { min: 1, max: 1, run: ([a]) => dateOf(a)?.getUTCDate() ?? null },
    weekday: { min: 1, max: 1, run: ([a]) => (dateOf(a) ? dateOf(a)!.getUTCDay() || 7 : null) },
    monthstart: { min: 1, max: 1, run: ([a]) => (dateOf(a) ? `${isoDay(dateOf(a)!).slice(0, 8)}01` : null) },
    monthname: { min: 1, max: 1, run: ([a]) => (dateOf(a) ? `${MONTHS[dateOf(a)!.getUTCMonth()]} ${dateOf(a)!.getUTCFullYear()}` : null) },
    fystart: { min: 1, max: 1, run: ([a]) => (dateOf(a) ? `${fyStartYear(dateOf(a)!)}-04-01` : null) },
    fy: { min: 1, max: 1, run: ([a]) => (dateOf(a) ? `${fyStartYear(dateOf(a)!)}-${String((fyStartYear(dateOf(a)!) + 1) % 100).padStart(2, '0')}` : null) },
    daysbetween: { min: 2, max: 2, run: ([a, b]) => (dateOf(a) && dateOf(b) ? Math.round((dateOf(b)!.getTime() - dateOf(a)!.getTime()) / 86_400_000) : null) },
    adddays: { min: 2, max: 2, run: ([a, n]) => (dateOf(a) ? isoDay(new Date(dateOf(a)!.getTime() + (numeric(n) ?? 0) * 86_400_000)) : null) },
    today: { min: 0, max: 0, run: () => isoDay(new Date()) },
    now: { min: 0, max: 0, run: () => new Date() },
    // What a value is (requests often send an id or a record, a code or an object).
    istext: { min: 1, max: 1, run: ([v]) => typeof v === 'string' },
    isnumber: { min: 1, max: 1, run: ([v]) => typeof v === 'number' && Number.isFinite(v) },
    islist: { min: 1, max: 1, run: ([v]) => Array.isArray(v) },
    isobject: { min: 1, max: 1, run: ([v]) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) },
    // Lists (`data.items`, rows a step found). A `path` names a field of each item: 'qty', 'batch.id'.
    count: { min: 1, max: 2, run: ([items, path]) => (path === undefined ? list(items).length : valuesOf(items, path).filter((v) => truth(v) === true).length) },
    sum: { min: 1, max: 2, run: ([items, path]) => valuesOf(items, path).reduce<number>((total, v) => total + (numeric(v) ?? 0), 0) },
    pluck: { min: 2, max: 2, run: ([items, path]) => valuesOf(items, path) },
    distinct: { min: 1, max: 2, run: ([items, path]) => { const seen = new Set<string>(); return valuesOf(items, path).filter((v) => !isNull(v) && !seen.has(sameKey(v)) && (seen.add(sameKey(v)), true)); } },
    flatten: { min: 1, max: 1, run: ([items]) => list(items).flatMap((v) => list(v)) },
    union: { min: 2, max: 6, run: (lists) => lists.flatMap((v) => list(v)) },
    except: { min: 2, max: 2, run: ([items, remove]) => { const gone = new Set(list(remove).map(sameKey)); return list(items).filter((v) => !gone.has(sameKey(v))); } },
    first: { min: 1, max: 1, run: ([items]) => list(items)[0] ?? null },
    any: { min: 2, max: 3, run: ([items, path, value]) => list(items).some((item) => (value === undefined ? truth(pick(item, path)) === true : compare(pick(item, path), value) === 0)) },
    every: { min: 2, max: 3, run: ([items, path, value]) => list(items).every((item) => (value === undefined ? truth(pick(item, path)) === true : compare(pick(item, path), value) === 0)) },
    filter: { min: 3, max: 3, run: ([items, path, value]) => list(items).filter((item) => compare(pick(item, path), value) === 0) },
    /** The id of a reference sent either as an id or as a record (`{ id, name }`), else null. */
    idof: { min: 1, max: 1, run: ([v]) => (typeof v === 'number' ? v : v && typeof v === 'object' && typeof pick(v, 'id') === 'number' ? pick(v, 'id') : null) },
  }),
);

/** Adds a function to every expression (`defineExpressionFunction('gstStateCode', { min: 1, max: 1, run: ([gstin]) => ... })`). */
export function defineExpressionFunction(name: string, fn: ExpressionFunction): void {
  const key = name.toLowerCase();
  if (FUNCTIONS.has(key)) throw new Error(`Expression function "${name}" already exists`);
  FUNCTIONS.set(key, fn);
}

/** Function names expressions may call. */
export function expressionFunctions(): string[] {
  return [...FUNCTIONS.keys()];
}

/** Throws at definition time for unknown functions or a wrong number of arguments. */
export function checkFunctions(ast: Ast): void {
  if (ast.k === 'call') {
    if (ast.fn === 'under' || ast.fn === 'picked') throw new ExpressionError(`${ast.fn}() works in reports only`);
    const fn = FUNCTIONS.get(ast.fn);
    if (!fn) throw new ExpressionError(`Unknown function ${ast.fn}()`);
    if (ast.args.length < fn.min || ast.args.length > fn.max) throw new ExpressionError(`${ast.fn}() takes ${fn.min === fn.max ? fn.min : `${fn.min} to ${fn.max}`} inputs`);
    ast.args.forEach(checkFunctions);
    return;
  }
  for (const child of Object.values(ast)) {
    if (Array.isArray(child)) child.forEach((c) => typeof c === 'object' && c && 'k' in c && checkFunctions(c as Ast));
    else if (typeof child === 'object' && child && 'k' in child) checkFunctions(child as Ast);
  }
}

function textOp(op: 'contains' | 'starts' | 'ends', value: unknown, arg: unknown): boolean | null {
  if (isNull(value) || isNull(arg)) return null;
  const [v, a] = [String(value).toLowerCase(), String(arg).toLowerCase()];
  return op === 'contains' ? v.includes(a) : op === 'starts' ? v.startsWith(a) : v.endsWith(a);
}

/** Runs a parsed expression against a scope. SQL semantics for null: comparisons with null are unknown. */
export function evaluate(ast: Ast, scope: ExpressionScope): unknown {
  const ev = (node: Ast) => evaluate(node, scope);
  switch (ast.k) {
    case 'num':
    case 'str':
    case 'bool':
      return ast.v;
    case 'null':
      return null;
    case 'name':
      return scope.name(ast.v) ?? null;
    case 'param':
      if (!scope.param) throw new ExpressionError(`@${ast.v}: no parameters here`);
      return scope.param(ast.v) ?? null;
    case 'neg': {
      const n = numeric(ev(ast.v));
      return n === null ? null : -n;
    }
    case 'not': {
      const value = truth(ev(ast.v));
      return value === null ? null : !value;
    }
    case 'bin': {
      if (ast.op === 'and') {
        const l = truth(ev(ast.l));
        if (l === false) return false;
        const r = truth(ev(ast.r));
        return r === false ? false : l === null || r === null ? null : true;
      }
      if (ast.op === 'or') {
        const l = truth(ev(ast.l));
        if (l === true) return true;
        const r = truth(ev(ast.r));
        return r === true ? true : l === null || r === null ? null : false;
      }
      const [l, r] = [ev(ast.l), ev(ast.r)];
      if (['=', '!=', '>', '>=', '<', '<='].includes(ast.op)) {
        const c = compare(l, r);
        if (c === null) return null;
        return { '=': c === 0, '!=': c !== 0, '>': c > 0, '>=': c >= 0, '<': c < 0, '<=': c <= 0 }[ast.op as '='];
      }
      if (ast.op === '+' && (typeof l === 'string' || typeof r === 'string') && (numeric(l) === null || numeric(r) === null)) {
        return isNull(l) || isNull(r) ? null : `${String(l)}${String(r)}`;
      }
      const [a, b] = [numeric(l), numeric(r)];
      if (a === null || b === null) return null;
      switch (ast.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return b === 0 ? null : a / b;
        case '%':
          return b === 0 ? null : a % b;
        default:
          throw new ExpressionError(`Unknown operator ${ast.op}`);
      }
    }
    case 'between': {
      const v = ev(ast.v);
      const [lo, hi] = [compare(v, ev(ast.lo)), compare(v, ev(ast.hi))];
      if (lo === null || hi === null) return null;
      const inside = lo >= 0 && hi <= 0;
      return ast.not ? !inside : inside;
    }
    case 'in': {
      const v = ev(ast.v);
      if (isNull(v)) return null;
      const items = Array.isArray(ast.items) ? ast.items.map(ev) : ((ev(ast.items) as unknown[] | null) ?? []);
      const found = (Array.isArray(items) ? items : [items]).some((item) => compare(v, item) === 0);
      return ast.not ? !found : found;
    }
    case 'isnull': {
      const v = ev(ast.v);
      const empty = isNull(v) || (ast.empty && (v === '' || (Array.isArray(v) && v.length === 0)));
      return ast.not ? !empty : empty;
    }
    case 'text': {
      const result = textOp(ast.op, ev(ast.v), ev(ast.arg));
      return result === null ? null : ast.not ? !result : result;
    }
    case 'call': {
      const fn = FUNCTIONS.get(ast.fn);
      if (!fn) throw new ExpressionError(`Unknown function ${ast.fn}()`);
      // `if` evaluates only the branch it returns.
      if (ast.fn === 'if') return truth(ev(ast.args[0]!)) ? ev(ast.args[1]!) : ast.args[2] ? ev(ast.args[2]) : null;
      return fn.run(ast.args.map(ev));
    }
  }
}

/** A checked, parsed expression, ready to run many times. */
export interface CompiledExpression {
  source: string;
  ast: Ast;
  run(scope: ExpressionScope): unknown;
}

const compiled = new Map<string, CompiledExpression>();

/** Parses and checks once; the same source is compiled once per process. */
export function compileExpression(source: string): CompiledExpression {
  const hit = compiled.get(source);
  if (hit) return hit;
  const ast = parseExpression(source);
  checkFunctions(ast);
  const out: CompiledExpression = { source, ast, run: (scope) => evaluate(ast, scope) };
  if (compiled.size < 10_000) compiled.set(source, out);
  return out;
}

/** `true` only for a definite yes (null and unknown are no). */
export function isTrue(value: unknown): boolean {
  return truth(value) === true;
}

export { ExpressionError };
