import { Logger, type Type } from '@nestjs/common';
import { plainToInstance, Transform } from 'class-transformer';
import { Allow, IsArray, IsBoolean, IsIn, IsOptional, IsString, ValidateBy, ValidateNested, validateSync, type ValidationError } from 'class-validator';
import type { Issues } from './issues.js';

/**
 * Typed JSON columns.
 *
 * A JSON column is described by a shape class whose fields use the `JsonField.*` decorators below. On a
 * write (`jsonColumns` of a CRUD service, or `applyJsonColumns` from a step) the value sent for the
 * column is checked against its shape:
 * - a value of the wrong type is refused with its path (`itemSettings.qtyDecimal`), every problem at once;
 * - a key the shape does not declare is dropped and logged once (so the shape can be completed), unless
 *   the client sent it back unchanged from the stored value (a form that loads the column and posts it
 *   whole): then it is kept, so a missing schema entry never erases stored data;
 * - the stored value becomes the checked value: the column is replaced, as a plain JSON update does.
 */

type Primitive = 'text' | 'number' | 'boolean';

/** What a nested field accepts besides an object of its shape (a branch stored as `1` or as the record). */
interface NestedMeta {
  or: readonly Primitive[];
  /** Entries of a map or a list may be null. */
  nullEntries: boolean;
}

const NESTED = new WeakMap<object, Map<string, NestedMeta>>();

function remember(target: object, key: string, meta: NestedMeta): void {
  const own = NESTED.get(target) ?? new Map<string, NestedMeta>();
  own.set(key, meta);
  NESTED.set(target, own);
}

function metaOf(instance: object | null | undefined, key: string): NestedMeta | undefined {
  for (let proto = instance ? Object.getPrototypeOf(instance) : null; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    const found = NESTED.get(proto)?.get(key);
    if (found) return found;
  }
  return undefined;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Map);

const matches = (value: unknown, kinds: readonly Primitive[]): boolean =>
  kinds.some((kind) => (kind === 'text' ? typeof value === 'string' : kind === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === 'boolean'));

const toShape = <T>(shape: () => Type<T>, value: unknown): unknown => (isPlainObject(value) ? plainToInstance(shape(), value) : value);

type Decorate = (target: object, key: string) => void;
const all =
  (...decorators: Decorate[]): PropertyDecorator =>
  (target, key) => {
    for (const decorate of decorators) decorate(target, key as string);
  };

/** A number, or (with `numeric`) a string holding one (`"12"`, `"2.5"`). */
const NumberLike = (numeric: boolean) =>
  ValidateBy({
    name: numeric ? 'jsonNumeric' : 'jsonNumber',
    validator: {
      validate: (value) => (typeof value === 'number' && Number.isFinite(value)) || (numeric && typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())),
      defaultMessage: (args) => `${args?.property} must be a number`,
    },
  });

/** Field decorators of a JSON shape. Every field may be left out or null: settings are partial. */
export const JsonField = {
  bool: () => all(IsOptional(), IsBoolean()),
  text: () => all(IsOptional(), IsString()),
  /** A number; `numeric: true` also takes a string holding one, as older forms stored it. */
  number: (options: { numeric?: boolean } = {}) => all(IsOptional(), NumberLike(options.numeric === true)),
  /** One of these values (strings or numbers). */
  oneOf: (values: readonly (string | number)[]) => all(IsOptional(), IsIn(values as unknown[])),
  /** Anything (kept as sent): for values the shape deliberately leaves open. */
  any: () => all(IsOptional(), Allow()),
  /** An object of `shape`; `or` also accepts these primitives (a record stored as its id). */
  object: <T>(shape: () => Type<T>, options: { or?: readonly Primitive[] } = {}): PropertyDecorator =>
    (target, key) => {
      remember(target, key as string, { or: options.or ?? [], nullEntries: false });
      all(IsOptional(), Transform(({ obj }) => toShape(shape, (obj as Record<string, unknown>)[key as string])) as Decorate, ValidateNested())(target, key);
    },
  /** A list of objects of `shape`, or of a primitive kind. */
  list: <T>(of: (() => Type<T>) | Primitive): PropertyDecorator =>
    (target, key) => {
      if (typeof of === 'string') {
        const kind = of;
        return all(
          IsOptional(),
          IsArray(),
          ValidateBy({
            name: `jsonListOf${kind}`,
            validator: { validate: (value) => !Array.isArray(value) || value.every((item) => matches(item, [kind])), defaultMessage: (args) => `${args?.property} must be a list of ${kind} values` },
          }),
        )(target, key);
      }
      remember(target, key as string, { or: [], nullEntries: false });
      all(
        IsOptional(),
        IsArray(),
        Transform(({ obj }) => {
          const raw = (obj as Record<string, unknown>)[key as string];
          return Array.isArray(raw) ? raw.map((item) => toShape(of, item)) : raw;
        }) as Decorate,
        ValidateNested(),
      )(target, key);
    },
  /** An object keyed by free names (series types, user ids, payment modes), each value of `shape` or null. */
  map: <T>(shape: () => Type<T>): PropertyDecorator =>
    (target, key) => {
      remember(target, key as string, { or: [], nullEntries: true });
      all(
        IsOptional(),
        Transform(({ obj }) => {
          const raw = (obj as Record<string, unknown>)[key as string];
          return isPlainObject(raw) ? new Map(Object.entries(raw).map(([name, item]) => [name, toShape(shape, item)])) : raw;
        }) as Decorate,
        ValidateNested(),
      )(target, key);
    },
};

/** One refused value: where, and why. */
export interface JsonProblem {
  path: string;
  message: string;
}

export interface JsonCheck {
  /** The checked value (unknown keys dropped), plain JSON. */
  value: unknown;
  problems: JsonProblem[];
  /** Paths of unknown keys dropped. */
  dropped: string[];
  /** Paths of unknown keys kept because they came back unchanged from the stored value. */
  kept: string[];
}

/** Class instances and maps back to plain JSON. */
function toPlain(value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([key, item]) => [key, toPlain(item)]));
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, toPlain(item)]));
  return value;
}

/** Validation errors as paths, leaving out the nested-type errors a field's `or` / null entries allow. */
function problemsOf(errors: ValidationError[], prefix: string, parent?: { owner: object | undefined; key: string; isEntry: boolean }): JsonProblem[] {
  const out: JsonProblem[] = [];
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    const constraints = { ...(error.constraints ?? {}) };
    if (constraints.nestedValidation) {
      // The error sits on a field of `error.target`, or (map / list entry) on an entry of the parent field.
      const meta = parent?.isEntry ? metaOf(parent.owner, parent.key) : metaOf(error.target, error.property);
      const value = error.value;
      if (meta && ((value === null && parent?.isEntry && meta.nullEntries) || matches(value, meta.or))) delete constraints.nestedValidation;
      else constraints.nestedValidation = `${error.property} must be an object`;
    }
    for (const message of Object.values(constraints)) out.push({ path, message });
    if (error.children?.length) {
      // Children of a map or list field are its entries; children of an entry are its fields.
      const entries = error.value instanceof Map || Array.isArray(error.value);
      out.push(...problemsOf(error.children, path, entries ? { owner: error.target, key: error.property, isEntry: true } : undefined));
    }
  }
  return out;
}

function get(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Keys the input had that the checked value lost (unknown keys), as paths under `prefix`. */
function lostKeys(input: unknown, output: unknown, path: string[], out: string[][]): void {
  if (Array.isArray(input) && Array.isArray(output)) {
    input.forEach((item, index) => lostKeys(item, output[index], [...path, String(index)], out));
    return;
  }
  if (!isPlainObject(input) || !isPlainObject(output)) return;
  for (const [key, item] of Object.entries(input)) {
    if (item === undefined) continue;
    if (!(key in output)) out.push([...path, key]);
    else lostKeys(item, output[key], [...path, key], out);
  }
}

/**
 * Check one JSON value against its shape. `path` prefixes the problem paths (the column name);
 * `stored` is the value the column holds now (unknown keys sent back unchanged from it are kept).
 */
export function checkJson(shape: Type<object>, input: unknown, options: { path?: string; stored?: unknown } = {}): JsonCheck {
  const path = options.path ?? '';
  if (input === null || input === undefined) return { value: input ?? null, problems: [], dropped: [], kept: [] };
  if (!isPlainObject(input)) return { value: input, problems: [{ path, message: `${path || 'value'} must be an object` }], dropped: [], kept: [] };
  const instance = plainToInstance(shape, structuredClone(input));
  const errors = validateSync(instance, { whitelist: true, forbidUnknownValues: false });
  const problems = problemsOf(errors, path);
  const value = toPlain(instance) as Record<string, unknown>;
  const lost: string[][] = [];
  lostKeys(input, value, [], lost);
  const dropped: string[] = [];
  const kept: string[] = [];
  for (const keyPath of lost) {
    const sent = get(input, keyPath);
    const full = [path, ...keyPath].filter(Boolean).join('.');
    if (options.stored !== undefined && same(get(options.stored, keyPath), sent)) {
      const parent = get(value, keyPath.slice(0, -1));
      if (typeof parent === 'object' && parent !== null) {
        (parent as Record<string, unknown>)[keyPath[keyPath.length - 1]!] = structuredClone(sent);
        kept.push(full);
        continue;
      }
    }
    dropped.push(full);
  }
  return { value, problems, dropped, kept };
}

const logger = new Logger('JsonColumns');
const logged = new Set<string>();

/** Logs an unknown key once per process (list indexes folded), so the shapes can be completed. */
function logUnknown(scope: string, paths: readonly string[], what: 'dropped' | 'kept (sent back unchanged)'): void {
  for (const path of paths) {
    const key = `${scope}:${path.replace(/\.\d+(?=\.|$)/g, '[]')}:${what}`;
    if (logged.has(key)) continue;
    logged.add(key);
    logger.warn(`${scope}: unknown key ${path} ${what}; add it to the column's shape if it is used`);
  }
}

/** The JSON columns of a model and their shapes: `{ itemSettings: ItemSettings }`. */
export type JsonColumns = Readonly<Record<string, Type<object>>>;

/** What `applyJsonColumns` needs of an operation's context. */
export interface JsonColumnsTarget {
  dto: unknown;
  before: Record<string, unknown> | null;
  row: { set(key: string, value: unknown): unknown; constructor: { name: string } };
  issues: Issues;
}

/**
 * Check the JSON columns a write sends (`c.dto`) against their shapes: problems become field errors
 * (`itemSettings.qtyDecimal`), unknown keys are dropped (or kept when sent back unchanged) and logged
 * once, and the row takes the checked value. Columns the write does not send are left alone. CRUD
 * services do it for their `jsonColumns` before the check steps; a step that saves by other means
 * calls it itself.
 */
export function applyJsonColumns(c: JsonColumnsTarget, columns: JsonColumns, scope = c.row.constructor.name): void {
  const dto = (c.dto ?? {}) as Record<string, unknown>;
  for (const [column, shape] of Object.entries(columns)) {
    if (!(column in dto) || dto[column] === undefined) continue;
    const result = checkJson(shape, dto[column], { path: column, stored: c.before?.[column] });
    for (const problem of result.problems) c.issues.field(problem.path, problem.message);
    logUnknown(scope, result.dropped, 'dropped');
    logUnknown(scope, result.kept, 'kept (sent back unchanged)');
    c.row.set(column, result.value);
  }
}
