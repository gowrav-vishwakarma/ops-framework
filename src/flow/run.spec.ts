import { describe, expect, it } from 'vitest';
import { Flow } from './builtin-kinds.js';
import { FlowRun, type FlowMethod } from './run.js';
import { boot, flowCtx, MemoryDb, runSteps } from './testing.spec-helpers.js';

const recorder = () => {
  const seen: unknown[] = [];
  const note: FlowMethod = (_run, args) => void seen.push(args.v);
  return { seen, methods: { note } };
};
const note = (v: string, extra: { when?: string; unless?: string } = {}) => Flow.call({ method: 'note', args: { v }, ...extra });

describe('step when and unless, with SQL null rules', () => {
  it.each([
    // [data.x, runs with when 'data.x > 1', runs with unless 'data.x > 1']
    [5, true, false],
    [0, false, true],
    [undefined, false, true],
    [null, false, true],
  ])('data.x = %s: when runs %s, unless runs %s', async (x, whenRuns, unlessRuns) => {
    const { seen, methods } = recorder();
    await runSteps([note("'when'", { when: 'data.x > 1' }), note("'unless'", { unless: 'data.x > 1' })], 'check', flowCtx(new MemoryDb(), { dto: { x } }), { methods });
    expect(seen).toEqual([...(whenRuns ? ['when'] : []), ...(unlessRuns ? ['unless'] : [])]);
  });

  it('both on one step: runs only when the when is true and the unless is not', async () => {
    const { seen, methods } = recorder();
    const c = flowCtx(new MemoryDb(), { dto: { a: true, b: false } });
    await runSteps([note('1', { when: 'data.a', unless: 'data.b' }), note('2', { when: 'data.a', unless: 'data.a' }), note('3', { when: 'data.b', unless: 'data.b' })], 'check', c, { methods });
    expect(seen).toEqual([1]);
  });

  it('is shown in the flow document and must be text', () => {
    expect(boot([note('1', { when: 'data.a', unless: 'data.b' })], 'check', {}, { note: () => 1 })()).toBe('call note() (when data.a) (unless data.b)');
    expect(boot([{ kind: 'stop', when: true }])).toThrow(/steps\[0\]: when is an expression \(text\)/);
    expect(boot([{ kind: 'stop', unless: 1 }])).toThrow(/steps\[0\]: unless is an expression \(text\)/);
    expect(boot([{ kind: 'stop', when: 'nope = 1' }])).toThrow(/steps\[0\]: "nope = 1": unknown name "nope"/);
    expect(boot([{ kind: 'stop', describe: 'the rest is for admins', when: 'data.a' }])()).toBe('the rest is for admins (when data.a)');
  });
});

describe('failed: stop at the first failed check', () => {
  it('Flow.stop({ when: "failed" }) ends the flow once a check failed', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { name: '' } });
    await runSteps([Flow.require({ fields: ['name'] }), Flow.stop({ when: 'failed' }), Flow.block({ message: 'expensive check' })], 'check', c);
    expect(c.issues.fields).toEqual({ name: ['name is required'] });
    expect(c.issues.blockers).toEqual([]);
  });

  it('without a failure the flow goes on; warnings are not failures', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { name: 'x' } });
    await runSteps([Flow.require({ fields: ['name'] }), Flow.warn({ message: 'sure?' }), Flow.stop({ when: 'failed' }), Flow.block({ message: 'reached' })], 'check', c);
    expect(c.issues.blockers).toEqual([{ code: 'blocked', message: 'reached' }]);
  });
});

describe('names', () => {
  it('a name a step gives reads as null until that step runs', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { skip: true } });
    await runSteps(
      [
        Flow.state({ values: { early: 'total', missing: 'notFound is null' } }),
        Flow.let({ values: { total: '5' } }),
        Flow.lookup({ model: 'X', where: { id: 1 }, as: 'neverRuns', when: 'not data.skip' }),
        Flow.state({ values: { late: 'total', skipped: 'neverRuns' } }),
        Flow.match({ model: 'X', field: 'f', values: 'data.none', as: 'm', missing: 'notFound', when: 'false' }),
      ],
      'check',
      c,
    );
    expect(c.state).toEqual({ early: null, missing: true, late: 5, skipped: null });
  });

  it('the roots: data, row, before, user, state, op, failed', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { a: 1 }, row: { id: 7 }, before: { id: 7, name: 'old' }, user: { id: 42 }, state: { s: 'x' }, op: 'update' });
    await runSteps([Flow.assign({ values: { 'state.all': "concat(data.a, row.id, before.name, user.id, state.s, op, failed)" } })], 'check', c);
    expect(c.state.all).toBe('17old42xupdatefalse');
    const created = flowCtx(new MemoryDb(), { dto: undefined, before: null });
    await runSteps([Flow.state({ values: { b: 'before.name', d: 'data.x' } })], 'check', created);
    expect(created.state).toEqual({ b: null, d: null });
  });

  it('an unknown name fails boot with the step position, nested lists included', () => {
    expect(boot([Flow.require({ fields: ['a'] }), Flow.block({ message: 'm', when: 'branch.id = 1' })])).toThrow(/steps\[1\]: "branch.id = 1": unknown name "branch" \(names: data, row, before, user, state, op, failed\)/);
    expect(boot([Flow.if({ test: 'true', then: [Flow.stop(), Flow.forEach({ items: 'data.x', as: 'i', steps: [Flow.block({ message: 'm', when: 'j > 1' })] })] })])).toThrow(/steps\[0\]\.0\[1\]\.0\[0\]: "j > 1": unknown name "j"/);
    // Names given anywhere in the file are known everywhere in it (they read null before).
    expect(boot([Flow.block({ message: 'm', when: 'later.x = 1' }), Flow.let({ values: { later: '1' } })])).not.toThrow();
    expect(boot([Flow.block({ message: 'm', when: 'i > 1' }), Flow.forEach({ items: 'data.x', as: 'i', steps: [] }), Flow.call({ method: 'f', as: 'r' })], 'check', {}, { f: () => 1 })).not.toThrow();
  });

  it('a name read by a run that the file does not give fails at run time (a project kind reading on its own)', async () => {
    const run = new FlowRun(flowCtx(), 'check', 'x.ts', {}, new Set(['given']));
    expect(run.value('given')).toBeNull();
    expect(() => run.value('other')).toThrow(/x.ts: unknown name "other" in an expression/);
  });

  // BUG: message templates (`block.message`, `warn.message`, `require.message`, `unique.message`,
  // probe messages, `lookup.required`) are not parsed at boot, so a typo in `{...}` passes boot and
  // fails only when the step runs, as a 422 the user sees. Fix: let these kinds return the `{...}`
  // parts of their templates from `expressions()` (a shared `templateExprs(text)` helper).
  it('a template naming an unknown name fails boot', () => {
    expect(boot([Flow.block({ message: 'Branch {brnch.name} is closed' })])).toThrow(/unknown name "brnch"/);
  });
});

describe('text templates', () => {
  it('fills {expressions}; null and missing values are empty; text outside braces is kept', async () => {
    const run = new FlowRun(flowCtx(new MemoryDb(), { dto: { name: 'Freight', amount: '12.5', when: '2026-02-01' } }), 'check', 'x.ts', {});
    expect(run.text('Charge "{data.name}" costs {data.amount * 2} in FY {fy(data.when)}')).toBe('Charge "Freight" costs 25 in FY 2025-26');
    expect(run.text('[{data.missing}] [{ data.name }] {}')).toBe('[] [Freight] {}');
    expect(run.text('no braces here')).toBe('no braces here');
    expect(run.text("{if(data.amount > 10, 'big', 'small')}")).toBe('big');
  });

  it('a bad expression inside braces fails when the text is made', () => {
    const run = new FlowRun(flowCtx(), 'check', 'x.ts', {});
    expect(() => run.text('{data.a +}')).toThrow();
  });
});

describe('who data steps act as', () => {
  it('the caller unless asSystem; unique and notReferenced always as the system', async () => {
    const db = new MemoryDb({ A: [{ id: 1, f: 'v', p: 1, k: 1 }] });
    const c = flowCtx(db, { dto: { name: 'n', list: ['v'] }, row: { id: 1 } });
    const pairs = (asSystem: boolean) => [
      Flow.lookup({ asSystem, model: 'A', where: { id: 1 }, as: 'l' }),
      Flow.find({ asSystem, model: 'A', where: { id: 1 }, as: 'f' }),
      Flow.match({ asSystem, model: 'A', field: 'f', values: 'data.list', as: 'm' }),
      Flow.create({ asSystem, model: 'A', values: { p: asSystem ? 3 : 2 } }),
      Flow.createMany({ asSystem, model: 'A', rows: 'data.list', when: 'false' }),
      Flow.createMany({ asSystem, model: 'A', each: 'data.list', as: 'i', values: { f: 'i' } }),
      Flow.update({ asSystem, model: 'A', where: { id: 1 }, values: { f: "'w'" } }),
      Flow.destroy({ asSystem, model: 'A', where: { id: 99 } }),
      Flow.syncChildren({ asSystem, model: 'A', parent: { p: asSystem ? 3 : 2 }, key: 'k', values: 'data.list' }),
    ];
    await runSteps([Flow.unique({ model: 'A', fields: ['name'] }), Flow.notReferenced({ probes: [{ model: 'A', field: 'none', message: 'm' }] }), ...pairs(false), ...pairs(true)], 'after', c);
    const caller = ['findOne', 'findAll', 'findAll', 'create', 'createMany', 'update', 'destroy', 'findAll', 'destroy', 'create'];
    expect(db.accessLog).toEqual([
      'count:A:system',
      'count:A:system',
      ...caller.map((k) => `${k}:A:caller`),
      ...caller.map((k) => `${k}:A:system`),
    ]);
  });

  it('the access carries the caller and their permissions', async () => {
    const db = new MemoryDb({ A: [] });
    const c = flowCtx(db, { user: { id: 5 }, scope: 'branch', can: { 'a.view': 'all' } });
    const run = new FlowRun(c, 'check', 'x.ts', {});
    const access = run.access();
    expect(access).toMatchObject({ system: false, ctx: { user: { id: 5 }, scope: 'branch' } });
    expect(await access.can('a.view')).toBe(true);
    expect(await access.can('a.delete')).toBe(false);
    expect(run.access(true).system).toBe(true);
  });
});

describe('nesting', () => {
  it('forEach inside if inside try: each item runs; a failure undoes only the try', async () => {
    const db = new MemoryDb({ Line: [] });
    const c = flowCtx(db, { dto: { post: true, lines: [{ n: 1 }, { n: 2 }, { n: 3 }] } });
    await runSteps(
      [
        Flow.try({
          steps: [
            Flow.if({
              test: 'data.post',
              then: [Flow.forEach({ items: 'data.lines', as: 'line', steps: [Flow.create({ model: 'Line', values: { n: 'line.n' }, unless: 'line.n = 2' })] })],
              else: [Flow.block({ message: 'not posted' })],
            }),
          ],
        }),
        Flow.state({ values: { count: "count(filter(data.lines, 'n', 3))" } }),
      ],
      'after',
      c,
    );
    expect(db.tables.Line!.map((r) => r.n)).toEqual([1, 3]);
    expect(c.savepoints).toBe(1);
    expect(c.state).toEqual({ count: 1 });
  });

  it('a stop deep inside ends the whole file', async () => {
    const { seen, methods } = recorder();
    await runSteps(
      [Flow.try({ steps: [Flow.if({ test: 'true', then: [Flow.forEach({ items: 'data.items', as: 'x', steps: [note('x'), Flow.stop({ when: 'x = 2' })] })] })] }), note("'after'")],
      'after',
      flowCtx(new MemoryDb(), { dto: { items: [1, 2, 3] } }),
      { methods },
    );
    expect(seen).toEqual([1, 2]);
  });
});

describe('errors', () => {
  it('an unexpected error names the flow file and kind; HTTP errors pass unchanged', async () => {
    await expect(runSteps([Flow.call({ method: 'boom' })], 'check', flowCtx(), { methods: { boom: () => { throw new TypeError('x is undefined'); } } })).rejects.toThrow('[flow spec.ts call] x is undefined');
    await expect(runSteps([Flow.block({ message: 'no' })], 'after', flowCtx())).rejects.toThrow(/^no$/);
  });

  it('set without a record fails clearly', async () => {
    const c = flowCtx();
    (c as { row?: unknown }).row = undefined;
    await expect(runSteps([Flow.set({ values: { a: '1' } })], 'before', c)).rejects.toThrow(/spec.ts: there is no record here to set fields on/);
  });
});
