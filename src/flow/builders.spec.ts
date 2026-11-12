import { describe, expect, it } from 'vitest';
import { Flow } from './builtin-kinds.js';
import { afterFlow, beforeFlow, checkFlow, flow } from './flow.js';
import { defineStepKind, stepKind, stepKindNames, type Field, type FlowStep } from './kinds.js';
import { boot, flowCtx, MemoryDb, runSteps } from './testing.spec-helpers.js';

interface Charge {
  id: number;
  name: string;
  defaultValue: number;
}

/** Compiles the argument without running it: for type tests of flows that would fail at boot. */
const compiles = (_build: () => unknown) => undefined;

/** One sample per built-in kind: its builder must give exactly `{ kind, ...args }`. */
const SAMPLES: Record<Exclude<keyof typeof Flow, 'do'>, Record<string, unknown> | undefined> = {
  block: { message: 'm', code: 'c', field: 'f' },
  warn: { message: 'm' },
  require: { fields: ['a'] },
  unique: { fields: ['name'], caseInsensitive: true },
  notReferenced: { probes: [{ model: 'T', field: 'f', message: 'm' }] },
  lookup: { model: 'B', where: { id: 1 }, as: 'b' },
  find: { model: 'B', where: { id: 1 }, as: 'b', limit: 5 },
  let: { values: { a: '1' } },
  state: { values: { a: '1' } },
  set: { from: 'data' },
  assign: { values: { 'data.a': '1' } },
  match: { model: 'S', field: 'f', values: 'data.v', as: 'm' },
  createMany: { model: 'S', rows: 'data.rows' },
  create: { model: 'S', values: 'data.row' },
  update: { model: 'S', where: { id: 1 }, values: {} },
  destroy: { model: 'S', where: { id: 1 } },
  syncChildren: { model: 'S', parent: { p: 1 }, key: 'k', values: 'data.v' },
  if: { test: 'true', then: [] },
  forEach: { items: 'data.v', as: 'x', steps: [] },
  try: { steps: [] },
  stop: undefined,
  call: { method: 'm', args: { a: '1' } },
  where: { values: { a: '1' } },
  decorate: { values: { a: '1' } },
};

describe('builders', () => {
  it('every Flow builder returns the object form of its step, with the common arguments', () => {
    for (const [name, args] of Object.entries(SAMPLES)) {
      const build = Flow[name as keyof typeof Flow] as (a?: object) => FlowStep;
      expect(build(args)).toEqual({ kind: name, ...args });
      expect(build({ ...args, when: 'data.a', unless: 'data.b', describe: 'd' })).toMatchObject({ kind: name, when: 'data.a', unless: 'data.b', describe: 'd' });
    }
  });

  it('there is one builder per registered built-in kind, and the samples cover them all', () => {
    expect(Object.keys(Flow).sort()).toEqual([...Object.keys(SAMPLES), 'do'].sort());
    for (const name of Object.keys(Flow)) expect(stepKind(name)?.name).toBe(name);
    expect(stepKindNames()).toEqual(expect.arrayContaining(Object.keys(Flow)));
  });

  it('Flow.do is plain code between the steps: described first, its result named for later steps', async () => {
    const paragraph = Flow.do('double the total', (c, named) => Number(named.total) * 2, { as: 'doubled', when: 'data.a' });
    expect(paragraph).toMatchObject({ kind: 'do', describe: 'double the total', as: 'doubled', when: 'data.a' });
    expect(typeof (paragraph as { run?: unknown }).run).toBe('function');
  });

  it('a builder never lets an argument named kind change the kind', () => {
    expect(Flow.block({ message: 'm', ...({ kind: 'stop' } as object) })).toMatchObject({ kind: 'block' });
  });

  it('argument-less builders can be called without arguments', () => {
    expect(Flow.stop()).toEqual({ kind: 'stop' });
    expect(Flow.stop({ when: 'failed' })).toEqual({ kind: 'stop', when: 'failed' });
  });

  it('builder steps and object steps are the same step', () => {
    const a = flow({ steps: [Flow.require({ fields: ['name'] }), Flow.stop({ when: 'failed' })] }).bindPhase('check', { file: 'x', op: 'save' });
    const b = flow({ steps: [{ kind: 'require', fields: ['name'] }, { kind: 'stop', when: 'failed' }] }).bindPhase('check', { file: 'x', op: 'save' });
    expect(a.describe).toBe(b.describe);
  });
});

describe('types: mistakes that do not compile', () => {
  it('field names are checked against the flow model, in builders and object steps', () => {
    checkFlow<Charge>({ steps: [Flow.unique({ fields: ['name', 'defaultValue'] }), { kind: 'unique', fields: ['id'] }] });
    beforeFlow<Charge>({ steps: [Flow.set({ values: { defaultValue: 'round(row.defaultValue, 2)' } }), { kind: 'set', values: { name: "'x'" } }] });
    // @ts-expect-error a typo in a unique field (builder)
    checkFlow<Charge>({ steps: [Flow.unique({ fields: ['nmae'] })] });
    // @ts-expect-error a typo in a unique field (object form)
    checkFlow<Charge>({ steps: [{ kind: 'unique', fields: ['nmae'] }] });
    // @ts-expect-error a typo in a set key (builder)
    beforeFlow<Charge>({ steps: [Flow.set({ values: { defaultValu: '1' } })] });
    // @ts-expect-error a typo in a set key (object form)
    beforeFlow<Charge>({ steps: [{ kind: 'set', values: { nmae: '1' } }] });
    // @ts-expect-error a builder typed for the model directly
    Flow.unique<Charge>({ fields: ['nmae'] });
    // Without a model any field name is accepted.
    checkFlow({ steps: [Flow.unique({ fields: ['anything'] })] });
  });

  it('kinds are checked against the phase of the helper', () => {
    compiles(() => checkFlow({ steps: [Flow.warn({ message: 'm' }), Flow.block({ message: 'm' }), Flow.lookup({ model: 'B', where: {}, as: 'b' })] }));
    compiles(() => beforeFlow({ steps: [Flow.set({ from: 'data' }), Flow.where({ values: {} }), Flow.create({ model: 'L', values: {} })] }));
    compiles(() => afterFlow({ steps: [Flow.decorate({ values: {} }), Flow.destroy({ model: 'L', where: { id: 1 } })] }));
    // @ts-expect-error warn asks for confirmation: check steps only
    compiles(() => beforeFlow({ steps: [Flow.warn({ message: 'm' })] }));
    // @ts-expect-error set is a before step
    compiles(() => afterFlow({ steps: [Flow.set({ from: 'data' })] }));
    // @ts-expect-error set is a before step (object form)
    compiles(() => checkFlow({ steps: [{ kind: 'set', from: 'data' }] }));
    // @ts-expect-error where is a list before step
    compiles(() => afterFlow({ steps: [Flow.where({ values: {} })] }));
    // @ts-expect-error decorate is a list after step
    compiles(() => beforeFlow({ steps: [Flow.decorate({ values: {} })] }));
    // @ts-expect-error a write in a check
    compiles(() => checkFlow({ steps: [Flow.destroy({ model: 'L', where: { id: 1 } })] }));
  });

  it('arguments are checked: required ones, unknown ones, kinds that do not exist', () => {
    // @ts-expect-error block needs a message
    compiles(() => Flow.block({}));
    // @ts-expect-error lookup has no `model_` argument
    compiles(() => Flow.lookup({ model: 'B', where: {}, as: 'b', model_: 'x' }));
    // @ts-expect-error when is an expression (text)
    compiles(() => Flow.stop({ when: true }));
    // @ts-expect-error a kind that does not exist
    compiles(() => flow({ steps: [{ kind: 'uniq', fields: ['name'] }] }));
    // @ts-expect-error only stop may be called without arguments
    compiles(() => Flow.require());
  });
});

// A project's own kinds: declared by merging, phases in FlowKindPhases, registered with defineStepKind.
declare module './kinds.js' {
  interface FlowStepKinds<M> {
    specTotal: { items: string; total: string; field?: Field<M> };
    specStamp: { field: Field<M> };
    specNoop: Record<never, never>;
  }
  interface FlowKindPhases {
    specStamp: 'before';
  }
}

const specTotal = defineStepKind({
  name: 'specTotal',
  expressions: (a) => [a.items],
  names: (a) => [a.total],
  validate: (a) => (a.total ? null : 'specTotal needs total'),
  run: async (run, a) => {
    const items = (run.value(a.items) as Array<{ amount: number }> | null) ?? [];
    run.vars.set(a.total, items.reduce((sum, item) => sum + item.amount, 0));
  },
  describe: (a) => `${a.total} = total of ${a.items}`,
});
const specStamp = defineStepKind({
  name: 'specStamp',
  phases: ['before'],
  target: 'row',
  fields: (a) => [a.field],
  run: async (run, a) => run.setRow({ [a.field]: 'stamped' }),
  describe: (a) => `stamp ${a.field}`,
});
const specNoop = defineStepKind({ name: 'specNoop', run: async () => undefined, describe: () => 'nothing' });

describe('project kinds: defineStepKind', () => {
  it('returns a builder; the names it gives are declared for later steps', async () => {
    expect(specTotal({ items: 'data.lines', total: 'sum' })).toEqual({ kind: 'specTotal', items: 'data.lines', total: 'sum' });
    const c = flowCtx(new MemoryDb(), { dto: { lines: [{ amount: 2 }, { amount: 3 }] } });
    await runSteps([specTotal({ items: 'data.lines', total: 'sum' }), Flow.block({ message: 'Total {sum} is too big', when: 'sum > 4' })], 'check', c);
    expect(c.issues.blockers).toEqual([{ code: 'blocked', message: 'Total 5 is too big' }]);
    expect(boot([Flow.block({ message: 'm', when: 'sum > 4' })])).toThrow(/unknown name "sum"/);
  });

  it('its validate, phases, target and fields are checked at boot', () => {
    expect(boot([{ kind: 'specTotal', items: 'data.x' }])).toThrow(/steps\[0\]: specTotal needs total/);
    expect(boot([specStamp({ field: 'name' })], 'check')).toThrow(/"specStamp" runs in before steps, not check/);
    expect(boot([specStamp({ field: 'name' })], 'before', { op: 'list' })).toThrow(/works on records/);
    expect(boot([specStamp({ field: 'nmae' })], 'before', { model: { name: 'Charge', attributes: ['id', 'name'] } })).toThrow(/Charge has no field "nmae"/);
    expect(boot([specStamp({ field: 'name' })], 'before')()).toBe('stamp name');
  });

  it('is typed like a built-in: phases, model fields, no-argument calls', () => {
    beforeFlow<Charge>({ steps: [specStamp<Charge>({ field: 'name' })] });
    expect(specNoop()).toEqual({ kind: 'specNoop' });
    // @ts-expect-error specStamp is a before step
    compiles(() => checkFlow<Charge>({ steps: [specStamp<Charge>({ field: 'name' })] }));
    // @ts-expect-error a typo in a field of the model
    compiles(() => beforeFlow<Charge>({ steps: [specStamp<Charge>({ field: 'nmae' })] }));
    // BUG (types): an argument typed with one `Field<M>` (not a list) does not infer M from the
    // flow, so a correct field fails to compile unless the model is written on the builder
    // (`specStamp<Charge>(...)`); `Field<M>[]` (unique.fields) infers fine. When the inference is
    // fixed (e.g. `NoInfer` on the argument and M taken from the contextual return type), this
    // directive becomes unused and tsc reports it.
    // @ts-expect-error see above: a correct field name that should compile
    compiles(() => beforeFlow<Charge>({ steps: [specStamp({ field: 'name' })] }));
    // @ts-expect-error specTotal needs items and total
    compiles(() => specTotal({ items: 'x' }));
  });

  it('a name is defined once', () => {
    expect(() => defineStepKind({ name: 'specNoop', run: async () => undefined, describe: () => '' })).toThrow(/Step kind "specNoop" is already defined/);
    expect(() => defineStepKind({ name: 'block' as never, run: async () => undefined, describe: () => '' })).toThrow(/"block" is already defined/);
  });
});
