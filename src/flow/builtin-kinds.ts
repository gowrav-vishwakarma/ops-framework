import { col, fn, Op, where as sqlWhere, type WhereOptions } from 'sequelize';
import type { Row } from './flow-db.js';
import { defineStepKind, type Field, type FlowStep } from './kinds.js';
import { rowValue, type FlowRun } from './run.js';

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
    unique: { fields: Field<M>[]; model?: string; caseInsensitive?: boolean; message?: string; field?: string };
    /** Refuse when other rows still point at this one (delete of a master in use). */
    notReferenced: { probes: Array<{ model: string; field: string; where?: Values; message: string }>; value?: string; code?: string };
    /** One row into a name: `{ model: 'Branch', where: { id: 'data.branchId' }, as: 'branch' }`. */
    lookup: { asSystem?: boolean; model: string; where: Values; as: string; fields?: string[]; required?: string };
    /** Rows into a name (at most `limit`, never more than the flow cap). */
    find: { asSystem?: boolean; model: string; where: Values; as: string; fields?: string[]; limit?: number };
    /** Names for later steps: `{ values: { total: 'data.qty * data.rate' } }`. */
    let: { values: Values };
    /** Values on `c.state` for later step files. */
    state: { values: Values };
    /** Fields of the record being saved. Before steps only: the main change saves them. */
    set: { values: Partial<Record<Field<M>, unknown>> };
    /** A new row of a model. */
    create: { asSystem?: boolean; model: string; values: Values; as?: string };
    /** Change rows of a model. */
    update: { asSystem?: boolean; model: string; where: Values; values: Values };
    /** Remove rows of a model. */
    destroy: { asSystem?: boolean; model: string; where: Values };
    /**
     * Child rows that must equal a list: rows of `model` under `parent` whose `key` is in `values`
     * are kept, missing ones are created (with `extra`), the others removed.
     */
    syncChildren: { asSystem?: boolean; model: string; parent: Values; key: string; values: string; extra?: Values };
    /** Branching: `then` when `test` is true, else `else`. */
    if: { test: string; then: FlowStep<M>[]; else?: FlowStep<M>[] };
    /** The steps once per item of a list, the item named `as`. */
    forEach: { items: string; as: string; steps: FlowStep<M>[] };
    /** Ends this flow file here (the next step files still run). */
    stop: Record<string, never>;
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
    update: 'before' | 'after';
    destroy: 'before' | 'after';
    syncChildren: 'before' | 'after';
    where: 'before';
    decorate: 'after';
  }
}

const exprs = (values: Values | undefined): string[] => Object.values(values ?? {}).filter((v): v is string => typeof v === 'string');
const WRITE_PHASES = ['before', 'after'] as const;
const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const modelOf = (run: FlowRun, model: string | undefined): string => {
  const name = model ?? (run.c.row as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  if (!name || name === 'Object') throw new Error('unique needs `model` here');
  return name;
};

defineStepKind({
  name: 'block',
  validate: (a) => (typeof a.message === 'string' && a.message ? null : 'block needs a message'),
  run: async (run, a) => run.block(a.code ?? 'blocked', run.text(a.message), a.field),
  describe: (a) => `block: ${a.message}`,
});

defineStepKind({
  name: 'warn',
  phases: ['check'],
  run: async (run, a) => run.warn(a.code ?? 'confirm', run.text(a.message)),
  describe: (a) => `warn: ${a.message}`,
});

defineStepKind({
  name: 'require',
  validate: (a) => (Array.isArray(a.fields) && a.fields.length ? null : 'require needs fields'),
  run: async (run, a) => {
    for (const field of a.fields) {
      if (isBlank(run.value(`data.${field}`))) run.block('required', a.message ? run.text(a.message) : `${field} is required`, field);
    }
  },
  describe: (a) => `require ${a.fields.join(', ')}`,
});

defineStepKind({
  name: 'unique',
  target: 'row',
  fields: (a) => (a.model ? [] : a.fields),
  validate: (a) => (Array.isArray(a.fields) && a.fields.length ? null : 'unique needs fields'),
  run: async (run, a) => {
    const model = modelOf(run, a.model);
    const conditions: WhereOptions[] = a.fields.map((field) => {
      const value = run.rowValue(field) ?? run.value(`data.${field}`);
      if (a.caseInsensitive && typeof value === 'string') return sqlWhere(fn('lower', col(field)), value.trim().toLowerCase()) as WhereOptions;
      return { [field]: value ?? null } as WhereOptions;
    });
    const id = run.rowValue('id');
    if (id !== null && id !== undefined) conditions.push({ id: { [Op.ne]: id } } as WhereOptions);
    if ((await run.db.count(run.t, run.access(true), model, { [Op.and]: conditions } as WhereOptions)) > 0) {
      const message = a.message ? run.text(a.message) : `${a.fields.join(', ')} already exists`;
      run.block('duplicate', message, a.field ?? (a.fields.length === 1 ? a.fields[0] : undefined));
    }
  },
  describe: (a) => `unique ${a.fields.join(' + ')}${a.caseInsensitive ? ' (any case)' : ''}`,
});

defineStepKind({
  name: 'notReferenced',
  target: 'row',
  expressions: (a) => [...(a.value ? [a.value] : []), ...a.probes.flatMap((p) => exprs(p.where))],
  validate: (a) => (Array.isArray(a.probes) && a.probes.length ? null : 'notReferenced needs probes'),
  run: async (run, a) => {
    const value = run.value(a.value ?? 'row.id');
    for (const probe of a.probes) {
      const count = await run.db.count(run.t, run.access(true), probe.model, { [probe.field]: value, ...run.values(probe.where) } as WhereOptions);
      if (count > 0) run.block(a.code ?? 'in_use', run.text(probe.message));
    }
  },
  describe: (a) => `not referenced by ${a.probes.map((p) => `${p.model}.${p.field}`).join(', ')}`,
});

defineStepKind({
  name: 'lookup',
  expressions: (a) => exprs(a.where),
  validate: (a) => (a.model && a.as && a.where ? null : 'lookup needs model, where and as'),
  run: async (run, a) => {
    const found = await run.db.findOne(run.t, run.access(a.asSystem), a.model, run.values(a.where), a.fields);
    if (!found && a.required) run.block('not_found', run.text(a.required));
    run.vars.set(a.as, found);
  },
  describe: (a) => `${a.asSystem ? '[as system] ' : ''}${a.as} = ${a.model} where ${Object.entries(a.where).map(([k, v]) => `${k} = ${String(v)}`).join(' and ')}`,
});

defineStepKind({
  name: 'find',
  expressions: (a) => exprs(a.where),
  validate: (a) => (a.model && a.as && a.where ? null : 'find needs model, where and as'),
  run: async (run, a) => {
    run.vars.set(a.as, await run.db.findAll(run.t, run.access(a.asSystem), a.model, run.values(a.where), { attributes: a.fields, limit: a.limit }));
  },
  describe: (a) => `${a.asSystem ? '[as system] ' : ''}${a.as} = ${a.model} rows where ${Object.entries(a.where).map(([k, v]) => `${k} = ${String(v)}`).join(' and ')}`,
});

defineStepKind({
  name: 'let',
  expressions: (a) => exprs(a.values),
  run: async (run, a) => {
    for (const [name, arg] of Object.entries(a.values)) run.vars.set(name, run.value(arg));
  },
  describe: (a) => `let ${Object.entries(a.values).map(([k, v]) => `${k} = ${String(v)}`).join(', ')}`,
});

defineStepKind({
  name: 'state',
  expressions: (a) => exprs(a.values),
  run: async (run, a) => {
    Object.assign(run.c.state, run.values(a.values));
  },
  describe: (a) => `state ${Object.keys(a.values).join(', ')}`,
});

defineStepKind({
  name: 'set',
  phases: ['before'],
  target: 'row',
  fields: (a) => Object.keys(a.values),
  expressions: (a) => exprs(a.values),
  run: async (run, a) => run.setRow(run.values(a.values)),
  describe: (a) => `set ${Object.entries(a.values).map(([k, v]) => `${k} = ${String(v)}`).join(', ')}`,
});

defineStepKind({
  name: 'create',
  phases: WRITE_PHASES,
  expressions: (a) => exprs(a.values),
  run: async (run, a) => {
    const created = await run.db.create(run.t, run.access(a.asSystem), a.model, run.values(a.values));
    if (a.as) run.vars.set(a.as, created);
  },
  describe: (a) => `${a.asSystem ? '[as system] ' : ''}create ${a.model}`,
});

defineStepKind({
  name: 'update',
  phases: WRITE_PHASES,
  expressions: (a) => [...exprs(a.where), ...exprs(a.values)],
  validate: (a) => (a.where && Object.keys(a.where).length ? null : 'update needs a where (it never changes every row)'),
  run: async (run, a) => {
    await run.db.update(run.t, run.access(a.asSystem), a.model, run.values(a.values), run.values(a.where));
  },
  describe: (a) => `${a.asSystem ? '[as system] ' : ''}update ${a.model} set ${Object.keys(a.values).join(', ')}`,
});

defineStepKind({
  name: 'destroy',
  phases: WRITE_PHASES,
  expressions: (a) => exprs(a.where),
  validate: (a) => (a.where && Object.keys(a.where).length ? null : 'destroy needs a where (it never removes every row)'),
  run: async (run, a) => {
    await run.db.destroy(run.t, run.access(a.asSystem), a.model, run.values(a.where));
  },
  describe: (a) => `${a.asSystem ? '[as system] ' : ''}destroy ${a.model} where ${Object.keys(a.where).join(', ')}`,
});

defineStepKind({
  name: 'syncChildren',
  phases: WRITE_PHASES,
  expressions: (a) => [a.values, ...exprs(a.parent), ...exprs(a.extra)],
  validate: (a) => (a.parent && Object.keys(a.parent).length && a.key ? null : 'syncChildren needs parent and key'),
  run: async (run, a) => {
    const parent = run.values(a.parent);
    const wanted = ((run.value(a.values) as unknown[] | null) ?? []).map((v) => (v && typeof v === 'object' ? rowValue(v, 'id') : v));
    const access = run.access(a.asSystem);
    const existing = (await run.db.findAll(run.t, access, a.model, parent, { attributes: [a.key] })).map((row) => row[a.key]);
    const keep = new Set(wanted.map(String));
    const stale = existing.filter((value) => !keep.has(String(value)));
    if (stale.length) await run.db.destroy(run.t, access, a.model, { ...parent, [a.key]: { [Op.in]: stale } } as Row);
    const have = new Set(existing.map(String));
    const extra = run.values(a.extra);
    for (const value of wanted) if (!have.has(String(value))) await run.db.create(run.t, access, a.model, { ...parent, ...extra, [a.key]: value });
  },
  describe: (a) => `${a.asSystem ? '[as system] ' : ''}sync ${a.model}.${a.key} under ${Object.keys(a.parent).join(', ')} to ${a.values}`,
});

defineStepKind({
  name: 'if',
  expressions: (a) => [a.test],
  children: (a) => [a.then, ...(a.else ? [a.else] : [])],
  run: async (run, a) => run.steps(run.cond(a.test) ? a.then : (a.else ?? [])),
  describe: (a) => `if ${a.test}${a.else ? ' (else ...)' : ''}`,
});

defineStepKind({
  name: 'forEach',
  expressions: (a) => [a.items],
  children: (a) => [a.steps],
  validate: (a) => (a.as && Array.isArray(a.steps) ? null : 'forEach needs as and steps'),
  run: async (run, a) => {
    const items = (run.value(a.items) as unknown[] | null) ?? [];
    if (!Array.isArray(items)) throw new Error(`forEach: ${a.items} is not a list`);
    for (const item of items) {
      run.vars.set(a.as, item);
      if ((await run.steps(a.steps)) === 'stop') return 'stop';
    }
    run.vars.delete(a.as);
  },
  describe: (a) => `for each ${a.as} in ${a.items}`,
});

defineStepKind({
  name: 'stop',
  run: async () => 'stop',
  describe: () => 'stop',
});

defineStepKind({
  name: 'call',
  expressions: (a) => exprs(a.args),
  run: async (run, a) => {
    const result = await run.methods[a.method]!(run, run.values(a.args));
    if (a.as) run.vars.set(a.as, result);
  },
  describe: (a) => `call ${a.method}()`,
});

defineStepKind({
  name: 'where',
  phases: ['before'],
  target: 'list',
  expressions: (a) => exprs(a.values),
  run: async (run, a) => {
    if (!run.c.where) throw new Error('where works in list steps');
    run.c.where.push(run.values(a.values));
  },
  describe: (a) => `where ${Object.entries(a.values).map(([k, v]) => `${k} = ${String(v)}`).join(' and ')}`,
});

defineStepKind({
  name: 'decorate',
  phases: ['after'],
  target: 'list',
  expressions: (a) => exprs(a.values),
  run: async (run, a) => {
    for (const row of run.c.rows ?? []) {
      run.vars.set('item', row);
      for (const [key, value] of Object.entries(run.values(a.values))) {
        const target = row as { setDataValue?: (k: string, v: unknown) => void } & Row;
        if (typeof target.setDataValue === 'function') target.setDataValue(key, value);
        else target[key] = value;
      }
    }
    run.vars.delete('item');
  },
  describe: (a) => `decorate rows with ${Object.keys(a.values).join(', ')}`,
});
