import { Logger } from '@nestjs/common';
import { col, fn, Op, where as sqlWhere, type WhereOptions } from 'sequelize';
import type { Row } from './flow-db.js';
import { declaredNames, defineStepKind, type Field, type FlowStep } from './kinds.js';
import { rowValue, type FlowRun } from './run.js';
import type { OpContext } from '../crud/op-context.js';

/** The operation as a code paragraph (`Flow.do`) sees it: `row` typed as the flow's model. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FlowCodeContext<M = any> = Omit<OpContext<any, any, any>, 'row'> & {
  row: M;
};
/** A code paragraph: the operation, and the values earlier steps named (`as`, `let`...). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FlowCode<M = any> = (
  c: FlowCodeContext<M>,
  named: Record<string, any>,
) => unknown;

/** Expression-or-value maps: `{ name: 'data.name', isActive: true }`. */
export type Values = Record<string, unknown>;

/**
 * Data steps read and write as the caller: the tenant always, the caller's data scope (branch,
 * own...) unless the step says `asSystem: true`, and the row guards of the model written always.
 * `unique` and `notReferenced` count across the whole tenant (an integrity rule must see every
 * row) and return no data.
 */
declare module './kinds.js' {
  interface FlowStepKinds<M> {
    /** Refuse the operation (422) when `when` is true. `field` puts the message on a form field. */
    block: { code?: string; message: string; field?: string };
    /** Ask for confirmation (409) when `when` is true. Check steps only. */
    warn: { code?: string; message: string };
    /** Field errors for body fields that are empty. */
    require: { fields: string[]; message?: string };
    /** Another row of the model already has these values (the company is pinned by the framework). */
    unique: {
      fields: Field<M>[];
      model?: string;
      caseInsensitive?: boolean;
      message?: string;
      field?: string;
    };
    /** Refuse when other rows still point at this one (delete of a master in use). */
    notReferenced: {
      probes: Array<{
        model: string;
        field: string;
        where?: Values;
        message: string;
      }>;
      value?: string;
      code?: string;
    };
    /** One row into a name: `{ model: 'Branch', where: { id: 'data.branchId' }, as: 'branch' }`. */
    lookup: {
      asSystem?: boolean;
      model: string;
      where: Values;
      as: string;
      fields?: string[];
      required?: string;
    };
    /** Rows into a name (at most `limit`, never more than the flow cap). */
    find: {
      asSystem?: boolean;
      model: string;
      where: Values;
      as: string;
      fields?: string[];
      limit?: number;
    };
    /** Names for later steps: `{ values: { total: 'data.qty * data.rate' } }`. */
    let: { values: Values };
    /** Values on `c.state` for later step files. */
    state: { values: Values };
    /**
     * Fields of the record being saved. Before steps only: the main change saves them. `from` copies
     * every field of the model an object has (`from: 'data'`: the body as the record, the way a
     * classic `Model.create(body)` took it); `values` then override.
     */
    set: { values?: Partial<Record<Field<M>, unknown>>; from?: string };
    /**
     * Values into the request data or the operation state, by path:
     * `{ values: { 'data.gstType': "'igst'", 'state.total': 'sum(data.items, \'netTotal\')' } }`.
     * For APIs whose request is also their working document (classic payloads).
     */
    assign: { values: Values };
    /**
     * Splits a list of values into the ones a model has and the ones it has not:
     * `{ model: 'SerialNumber', field: 'serialNumber', values: 'move.serials', where: { status: "'in'" }, as: 'inStock', missing: 'notInStock' }`
     * names the rows found (`as`) and the values with no row (`missing`), in the list's order.
     */
    match: {
      asSystem?: boolean;
      model: string;
      field: string;
      values: string;
      where?: Values;
      as: string;
      missing?: string;
    };
    /**
     * Many new rows in one insert, in order: one per item of `each` (named `as` in `values`), or the
     * ready rows of `rows`. The saved rows (with ids and defaults) are named `into`.
     */
    createMany: {
      asSystem?: boolean;
      model: string;
      each?: string;
      as?: string;
      values?: Values;
      rows?: string;
      into?: string;
    };
    /** A new row of a model. `values`: a map of expressions, or one expression giving the object. */
    create: {
      asSystem?: boolean;
      model: string;
      values: Values | string;
      as?: string;
    };
    /** Change rows of a model. `values`: a map of expressions, or one expression giving the object. */
    update: {
      asSystem?: boolean;
      model: string;
      where: Values;
      values: Values | string;
    };
    /** Remove rows of a model. */
    destroy: { asSystem?: boolean; model: string; where: Values };
    /**
     * Child rows that must equal a list: rows of `model` under `parent` whose `key` is in `values`
     * are kept, missing ones are created (with `extra`), the others removed.
     */
    syncChildren: {
      asSystem?: boolean;
      model: string;
      parent: Values;
      key: string;
      values: string;
      extra?: Values;
    };
    /** Branching: `then` when `test` is true, else `else`. */
    if: { test: string; then: FlowStep<M>[]; else?: FlowStep<M>[] };
    /** The steps once per item of a list, the item named `as`. */
    forEach: { items: string; as: string; steps: FlowStep<M>[] };
    /**
     * Optional work: the steps run in a savepoint; when they fail for a reason that is not the
     * user's (anything but a 4xx refusal), only their changes are undone, the failure is logged and
     * the operation carries on.
     */
    try: { steps: FlowStep<M>[] };
    /**
     * A paragraph of plain code between the steps: `Flow.do('what it does', (c, { branch }) => {...})`.
     * `c` is the operation (`c.dto`, `c.row`, `c.state`, `c.t`, `c.issues`...), the second argument
     * the values earlier steps named. What it returns is named `as` for the steps after it.
     */
    do: { run: FlowCode<M>; as?: string };
    /** Ends this flow file here (the next step files still run). */
    stop: Record<never, never>;
    /** A method of this flow file (code), with evaluated arguments; its result named `as`. */
    call: { method: string; args?: Values; as?: string };
    /** List before steps: conditions added to the query (`{ values: { status: "'active'" } }`). */
    where: { values: Values };
    /** List after steps: values put on every row (`item` is the row). */
    decorate: { values: Values };
  }

  interface FlowKindPhases {
    warn: 'check';
    set: 'before';
    create: 'before' | 'after';
    createMany: 'before' | 'after';
    update: 'before' | 'after';
    destroy: 'before' | 'after';
    syncChildren: 'before' | 'after';
    where: 'before';
    decorate: 'after';
  }
}

const exprs = (values: Values | undefined): string[] =>
  Object.values(values ?? {}).filter((v): v is string => typeof v === 'string');
const WRITE_PHASES = ['before', 'after'] as const;
const ASSIGN_ROOTS = new Set(['data', 'state']);
const tryLogger = new Logger('Flow');
const isRefusal = (error: unknown) => {
  const status =
    (error as { getStatus?: () => number; status?: number })?.getStatus?.() ??
    (error as { status?: number })?.status;
  return typeof status === 'number' && status >= 400 && status < 500;
};
/** The `{...}` parts of a message template, checked at boot like any expression. */
const templateExprs = (...texts: Array<string | undefined>): string[] =>
  texts.flatMap((text) =>
    typeof text === 'string'
      ? [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim())
      : [],
  );
/** Path segments that would reach JavaScript internals instead of data. */
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
/** `values` as a map of expressions, or one expression giving the whole object (built by a method). */
const valuesOf = (run: FlowRun, values: Values | string): Row =>
  typeof values === 'string'
    ? { ...((run.value(values) as Row | null) ?? {}) }
    : run.values(values);
const exprsOf = (values: Values | string | undefined): string[] =>
  typeof values === 'string' ? [values] : exprs(values);
const isBlank = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === 'string' && value.trim() === '');
const modelOf = (run: FlowRun, model: string | undefined): string => {
  const name =
    model ??
    (run.c.row as { constructor?: { name?: string } } | undefined)?.constructor
      ?.name;
  if (!name || name === 'Object') throw new Error('unique needs `model` here');
  return name;
};

/** Plain code between the steps (`Flow.do`). */
const doKind = defineStepKind({
  name: 'do',
  validate: (a) => (typeof a.run === 'function' ? null : 'do needs a function'),
  run: async (run, a) => {
    const result = await a.run(run.c as never, Object.fromEntries(run.vars));
    if (a.as) run.vars.set(a.as, result);
  },
  describe: (a) => `code${a.as ? ` (as ${a.as})` : ''}`,
});

/**
 * The built-in step kinds, as builders: `Flow.lookup({ ... })`, `Flow.if({ ... })`. Ctrl+click
 * on a name opens its definition here.
 */
export const Flow = {
  block: defineStepKind({
    name: 'block',
    expressions: (a) => templateExprs(a.message),
    validate: (a) =>
      typeof a.message === 'string' && a.message
        ? null
        : 'block needs a message',
    run: async (run, a) =>
      run.block(a.code ?? 'blocked', run.text(a.message), a.field),
    describe: (a) => `block: ${a.message}`,
  }),

  warn: defineStepKind({
    name: 'warn',
    phases: ['check'],
    expressions: (a) => templateExprs(a.message),
    run: async (run, a) => run.warn(a.code ?? 'confirm', run.text(a.message)),
    describe: (a) => `warn: ${a.message}`,
  }),

  require: defineStepKind({
    name: 'require',
    expressions: (a) => templateExprs(a.message),
    validate: (a) =>
      Array.isArray(a.fields) && a.fields.length
        ? null
        : 'require needs fields',
    run: async (run, a) => {
      for (const field of a.fields) {
        if (isBlank(run.value(`data.${field}`)))
          run.block(
            'required',
            a.message ? run.text(a.message) : `${field} is required`,
            field,
          );
      }
    },
    describe: (a) => `require ${a.fields.join(', ')}`,
  }),

  unique: defineStepKind({
    name: 'unique',
    target: 'row',
    expressions: (a) => templateExprs(a.message),
    fields: (a) => (a.model ? [] : a.fields),
    validate: (a) =>
      Array.isArray(a.fields) && a.fields.length ? null : 'unique needs fields',
    run: async (run, a) => {
      const model = modelOf(run, a.model);
      const conditions: WhereOptions[] = a.fields.map((field) => {
        const value = run.rowValue(field) ?? run.value(`data.${field}`);
        if (a.caseInsensitive && typeof value === 'string')
          return sqlWhere(
            fn('lower', col(field)),
            value.trim().toLowerCase(),
          ) as WhereOptions;
        return { [field]: value ?? null } as WhereOptions;
      });
      const id = run.rowValue('id');
      if (id !== null && id !== undefined)
        conditions.push({ id: { [Op.ne]: id } } as WhereOptions);
      if (
        (await run.db.count(run.t, run.access(true), model, {
          [Op.and]: conditions,
        } as WhereOptions)) > 0
      ) {
        const message = a.message
          ? run.text(a.message)
          : `${a.fields.join(', ')} already exists`;
        run.block(
          'duplicate',
          message,
          a.field ?? (a.fields.length === 1 ? a.fields[0] : undefined),
        );
      }
    },
    describe: (a) =>
      `unique ${a.fields.join(' + ')}${a.caseInsensitive ? ' (any case)' : ''}`,
  }),

  notReferenced: defineStepKind({
    name: 'notReferenced',
    target: 'row',
    expressions: (a) => [
      ...(a.value ? [a.value] : []),
      ...a.probes.flatMap((p) => [
        ...exprs(p.where),
        ...templateExprs(p.message),
      ]),
    ],
    validate: (a) =>
      Array.isArray(a.probes) && a.probes.length
        ? null
        : 'notReferenced needs probes',
    run: async (run, a) => {
      const value = run.value(a.value ?? 'row.id');
      // Every probe in one statement; every table that holds a reference is reported.
      const found = await run.db.existsEach(
        run.t,
        run.access(true),
        a.probes.map((probe) => ({ model: probe.model, where: { [probe.field]: value, ...run.values(probe.where) } as WhereOptions })),
      );
      a.probes.forEach((probe, i) => {
        if (found[i]) run.block(a.code ?? 'in_use', run.text(probe.message));
      });
    },
    describe: (a) =>
      `not referenced by ${a.probes.map((p) => `${p.model}.${p.field}`).join(', ')}`,
  }),

  lookup: defineStepKind({
    name: 'lookup',
    expressions: (a) => [...exprs(a.where), ...templateExprs(a.required)],
    validate: (a) =>
      a.model && a.as && a.where ? null : 'lookup needs model, where and as',
    run: async (run, a) => {
      // A condition on a value that is not there (the branch has no GSTIN) finds nothing.
      const { where, missing } = run.whereValues(a.where);
      const found = missing
        ? null
        : await run.db.findOne(
            run.t,
            run.access(a.asSystem),
            a.model,
            where,
            a.fields,
          );
      if (!found && a.required) run.block('not_found', run.text(a.required));
      run.vars.set(a.as, found);
    },
    describe: (a) =>
      `${a.asSystem ? '[as system] ' : ''}${a.as} = ${a.model} where ${Object.entries(
        a.where,
      )
        .map(([k, v]) => `${k} = ${String(v)}`)
        .join(' and ')}`,
  }),

  find: defineStepKind({
    name: 'find',
    expressions: (a) => exprs(a.where),
    validate: (a) =>
      a.model && a.as && a.where ? null : 'find needs model, where and as',
    run: async (run, a) => {
      const { where, missing } = run.whereValues(a.where);
      run.vars.set(
        a.as,
        missing
          ? []
          : await run.db.findAll(
              run.t,
              run.access(a.asSystem),
              a.model,
              where,
              { attributes: a.fields, limit: a.limit },
            ),
      );
    },
    describe: (a) =>
      `${a.asSystem ? '[as system] ' : ''}${a.as} = ${a.model} rows where ${Object.entries(
        a.where,
      )
        .map(([k, v]) => `${k} = ${String(v)}`)
        .join(' and ')}`,
  }),

  let: defineStepKind({
    name: 'let',
    expressions: (a) => exprs(a.values),
    run: async (run, a) => {
      for (const [name, arg] of Object.entries(a.values))
        run.vars.set(name, run.value(arg));
    },
    describe: (a) =>
      `let ${Object.entries(a.values)
        .map(([k, v]) => `${k} = ${String(v)}`)
        .join(', ')}`,
  }),

  state: defineStepKind({
    name: 'state',
    expressions: (a) => exprs(a.values),
    run: async (run, a) => {
      Object.assign(run.c.state, run.values(a.values));
    },
    describe: (a) => `state ${Object.keys(a.values).join(', ')}`,
  }),

  set: defineStepKind({
    name: 'set',
    phases: ['before'],
    target: 'row',
    fields: (a) => Object.keys(a.values ?? {}),
    expressions: (a) => [...(a.from ? [a.from] : []), ...exprs(a.values)],
    validate: (a) => (a.values || a.from ? null : 'set needs values or from'),
    run: async (run, a) => {
      if (a.from) {
        const source = run.value(a.from);
        if (source && typeof source === 'object') {
          const attributes = Object.keys(
            (
              run.c.row as { constructor?: { getAttributes?: () => object } }
            )?.constructor?.getAttributes?.() ?? {},
          );
          const values: Row = {};
          for (const field of attributes)
            if (field in source) values[field] = (source as Row)[field];
          run.setRow(values);
        }
      }
      if (a.values) run.setRow(run.values(a.values));
    },
    describe: (a) =>
      `set ${[...(a.from ? [`the fields of ${a.from}`] : []), ...Object.entries(a.values ?? {}).map(([k, v]) => `${k} = ${String(v)}`)].join(', ')}`,
  }),

  assign: defineStepKind({
    name: 'assign',
    expressions: (a) => exprs(a.values),
    validate: (a) => {
      const paths = Object.keys(a.values ?? {});
      const unsafe = paths.find((path) =>
        path.split('.').some((key) => UNSAFE_SEGMENTS.has(key)),
      );
      if (unsafe)
        return `assign: "${unsafe}" names a JavaScript internal, not data`;
      const bad = paths.find(
        (path) =>
          !ASSIGN_ROOTS.has(path.split('.')[0]!) || path.split('.').length < 2,
      );
      return bad
        ? `assign: "${bad}" must be a path under data or state (data.gstType)`
        : null;
    },
    run: async (run, a) => {
      for (const [path, arg] of Object.entries(a.values)) {
        const [root, ...keys] = path.split('.');
        let target = (root === 'data' ? run.c.dto : run.c.state) as Row;
        if (keys.some((key) => UNSAFE_SEGMENTS.has(key)))
          throw new Error(`assign: "${path}" names a JavaScript internal`);
        for (const key of keys.slice(0, -1)) {
          const next = Object.hasOwn(target, key) ? target[key] : undefined;
          target = (
            next && typeof next === 'object' ? next : (target[key] = {})
          ) as Row;
        }
        target[keys[keys.length - 1]!] = run.value(arg);
      }
    },
    describe: (a) =>
      Object.entries(a.values)
        .map(([k, v]) => `${k} = ${String(v)}`)
        .join(', '),
  }),

  match: defineStepKind({
    name: 'match',
    expressions: (a) => [a.values, ...exprs(a.where)],
    validate: (a) =>
      a.model && a.field && a.values && a.as
        ? null
        : 'match needs model, field, values and as',
    run: async (run, a) => {
      const seen = new Set<string>();
      const wanted = ((run.value(a.values) as unknown[] | null) ?? []).filter(
        (v) =>
          v !== null &&
          v !== undefined &&
          !seen.has(String(v)) &&
          (seen.add(String(v)), true),
      );
      const { where, missing } = run.whereValues(a.where);
      const found_ =
        wanted.length && !missing
          ? await run.db.findAll(run.t, run.access(a.asSystem), a.model, {
              ...where,
              [a.field]: { [Op.in]: wanted },
            })
          : [];
      // In the order of the list, like `missing`.
      const position = new Map(
        wanted.map((value, index) => [String(value), index]),
      );
      const rows = [...found_].sort(
        (x, y) =>
          (position.get(String(x[a.field])) ?? 0) -
          (position.get(String(y[a.field])) ?? 0),
      );
      const found = new Set(rows.map((row) => String(row[a.field])));
      run.vars.set(a.as, rows);
      if (a.missing)
        run.vars.set(
          a.missing,
          wanted.filter((v) => !found.has(String(v))),
        );
    },
    describe: (a) =>
      `${a.asSystem ? '[as system] ' : ''}${a.as} = ${a.model} rows whose ${a.field} is in ${a.values}${
        a.where
          ? ` and ${Object.entries(a.where)
              .map(([k, v]) => `${k} = ${String(v)}`)
              .join(' and ')}`
          : ''
      }${a.missing ? `; ${a.missing} = the values with no such row` : ''}`,
  }),

  createMany: defineStepKind({
    name: 'createMany',
    phases: WRITE_PHASES,
    expressions: (a) => [
      ...(a.each ? [a.each] : []),
      ...(a.rows ? [a.rows] : []),
      ...exprs(a.values),
    ],
    validate: (a) =>
      a.rows
        ? null
        : a.each && a.as && a.values
          ? null
          : 'createMany needs rows, or each + as + values',
    run: async (run, a) => {
      let rows: Row[];
      if (a.rows)
        rows = ((run.value(a.rows) as Row[] | null) ?? []).map((row) => ({
          ...row,
        }));
      else {
        rows = [];
        for (const item of (run.value(a.each!) as unknown[] | null) ?? []) {
          run.vars.set(a.as!, item);
          rows.push(run.values(a.values));
        }
        run.vars.delete(a.as!);
      }
      const saved = rows.length
        ? await run.db.createMany(run.t, run.access(a.asSystem), a.model, rows)
        : [];
      if (a.into) run.vars.set(a.into, saved);
    },
    describe: (a) =>
      `${a.asSystem ? '[as system] ' : ''}create ${a.model} rows ${a.rows ? `from ${a.rows}` : `one per ${a.as} in ${a.each}`}${a.into ? ` (as ${a.into})` : ''}`,
  }),

  create: defineStepKind({
    name: 'create',
    phases: WRITE_PHASES,
    expressions: (a) => exprsOf(a.values),
    run: async (run, a) => {
      const created = await run.db.create(
        run.t,
        run.access(a.asSystem),
        a.model,
        valuesOf(run, a.values),
      );
      if (a.as) run.vars.set(a.as, created);
    },
    describe: (a) => `${a.asSystem ? '[as system] ' : ''}create ${a.model}`,
  }),

  update: defineStepKind({
    name: 'update',
    phases: WRITE_PHASES,
    expressions: (a) => [...exprs(a.where), ...exprsOf(a.values)],
    validate: (a) =>
      a.where && Object.keys(a.where).length
        ? null
        : 'update needs a where (it never changes every row)',
    run: async (run, a) => {
      // A condition on a value that is not there changes nothing (never `IS NULL` rows).
      const { where, missing } = run.whereValues(a.where);
      if (missing) return;
      await run.db.update(
        run.t,
        run.access(a.asSystem),
        a.model,
        valuesOf(run, a.values),
        where,
      );
    },
    describe: (a) =>
      `${a.asSystem ? '[as system] ' : ''}update ${a.model} set ${typeof a.values === 'string' ? a.values : Object.keys(a.values).join(', ')}`,
  }),

  destroy: defineStepKind({
    name: 'destroy',
    phases: WRITE_PHASES,
    expressions: (a) => exprs(a.where),
    validate: (a) =>
      a.where && Object.keys(a.where).length
        ? null
        : 'destroy needs a where (it never removes every row)',
    run: async (run, a) => {
      // A condition on a value that is not there removes nothing (never `IS NULL` rows).
      const { where, missing } = run.whereValues(a.where);
      if (missing) return;
      await run.db.destroy(run.t, run.access(a.asSystem), a.model, where);
    },
    describe: (a) =>
      `${a.asSystem ? '[as system] ' : ''}destroy ${a.model} where ${Object.keys(a.where).join(', ')}`,
  }),

  syncChildren: defineStepKind({
    name: 'syncChildren',
    phases: WRITE_PHASES,
    expressions: (a) => [a.values, ...exprs(a.parent), ...exprs(a.extra)],
    validate: (a) =>
      a.parent && Object.keys(a.parent).length && a.key
        ? null
        : 'syncChildren needs parent and key',
    run: async (run, a) => {
      const { where: parent, missing } = run.whereValues(a.parent);
      if (missing) return;
      // Each value once; empty values are not children.
      const seen = new Set<string>();
      const wanted = ((run.value(a.values) as unknown[] | null) ?? [])
        .map((v) => (v && typeof v === 'object' ? rowValue(v, 'id') : v))
        .filter(
          (v) =>
            v !== null &&
            v !== undefined &&
            !seen.has(String(v)) &&
            (seen.add(String(v)), true),
        );
      const access = run.access(a.asSystem);
      const existing = (
        await run.db.findAll(run.t, access, a.model, parent, {
          attributes: [a.key],
        })
      ).map((row) => row[a.key]);
      const keep = new Set(wanted.map(String));
      const stale = existing.filter((value) => !keep.has(String(value)));
      if (stale.length)
        await run.db.destroy(run.t, access, a.model, {
          ...parent,
          [a.key]: { [Op.in]: stale },
        } as Row);
      const have = new Set(existing.map(String));
      const extra = run.values(a.extra);
      for (const value of wanted)
        if (!have.has(String(value)))
          await run.db.create(run.t, access, a.model, {
            ...parent,
            ...extra,
            [a.key]: value,
          });
    },
    describe: (a) =>
      `${a.asSystem ? '[as system] ' : ''}sync ${a.model}.${a.key} under ${Object.keys(a.parent).join(', ')} to ${a.values}`,
  }),

  if: defineStepKind({
    name: 'if',
    validate: (a) =>
      Array.isArray(a.then) && (a.else === undefined || Array.isArray(a.else))
        ? null
        : 'if needs then (a list of steps)',
    expressions: (a) => [a.test],
    children: (a) => [a.then, ...(a.else ? [a.else] : [])],
    run: async (run, a) =>
      run.steps(run.cond(a.test) ? a.then : (a.else ?? [])),
    describe: (a) => `if ${a.test}${a.else ? ' (else ...)' : ''}`,
  }),

  forEach: defineStepKind({
    name: 'forEach',
    expressions: (a) => [a.items],
    children: (a) => [a.steps],
    validate: (a) =>
      a.as && Array.isArray(a.steps) ? null : 'forEach needs as and steps',
    run: async (run, a) => {
      const items = (run.value(a.items) as unknown[] | null) ?? [];
      if (!Array.isArray(items))
        throw new Error(`forEach: ${a.items} is not a list`);
      // Names given inside the loop start empty for each item: a step skipped for this item never
      // shows the value it had for the previous one.
      const inner = [...declaredNames(a.steps)];
      for (const item of items) {
        for (const name of inner) run.vars.delete(name);
        run.vars.set(a.as, item);
        if ((await run.steps(a.steps)) === 'stop') return 'stop';
      }
      run.vars.delete(a.as);
    },
    describe: (a) => `for each ${a.as} in ${a.items}`,
  }),

  try: defineStepKind({
    name: 'try',
    children: (a) => [a.steps],
    validate: (a) => (Array.isArray(a.steps) ? null : 'try needs steps'),
    run: async (run, a) => {
      const work = () => run.steps(a.steps);
      try {
        if (
          (await (run.c.savepoint ? run.c.savepoint(work) : work())) === 'stop'
        )
          return 'stop';
      } catch (error) {
        if (isRefusal(error)) throw error;
        tryLogger.warn(
          `${run.file}: optional steps failed and were undone: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    describe: () => 'try (a failure undoes only these steps)',
  }),

  do: <M = any>(
    describe: string,
    run: FlowCode<M>,
    options: { as?: string; when?: string; unless?: string } = {},
  ) => doKind<M>({ describe, run, ...options }),

  stop: defineStepKind({
    name: 'stop',
    run: async () => 'stop',
    describe: () => 'stop',
  }),

  call: defineStepKind({
    name: 'call',
    validate: (a) =>
      typeof a.method === 'string' && a.method ? null : 'call needs a method',
    expressions: (a) => exprs(a.args),
    run: async (run, a) => {
      if (!Object.hasOwn(run.methods, a.method))
        throw new Error(`no method "${a.method}" in this flow`);
      const result = await run.methods[a.method]!(run, run.values(a.args));
      if (a.as) run.vars.set(a.as, result);
    },
    describe: (a) => `call ${a.method}()`,
  }),

  where: defineStepKind({
    name: 'where',
    phases: ['before'],
    target: 'list',
    expressions: (a) => exprs(a.values),
    run: async (run, a) => {
      if (!run.c.where) throw new Error('where works in list steps');
      run.c.where.push(run.values(a.values));
    },
    describe: (a) =>
      `where ${Object.entries(a.values)
        .map(([k, v]) => `${k} = ${String(v)}`)
        .join(' and ')}`,
  }),

  decorate: defineStepKind({
    name: 'decorate',
    names: () => ['item'],
    phases: ['after'],
    target: 'list',
    expressions: (a) => exprs(a.values),
    run: async (run, a) => {
      for (const row of run.c.rows ?? []) {
        run.vars.set('item', row);
        for (const [key, value] of Object.entries(run.values(a.values))) {
          const target = row as {
            setDataValue?: (k: string, v: unknown) => void;
          } & Row;
          if (typeof target.setDataValue === 'function')
            target.setDataValue(key, value);
          else target[key] = value;
        }
      }
      run.vars.delete('item');
    },
    describe: (a) => `decorate rows with ${Object.keys(a.values).join(', ')}`,
  }),
};
