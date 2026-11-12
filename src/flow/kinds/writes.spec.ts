import { describe, expect, it } from 'vitest';
import { Flow } from '../builtin-kinds.js';
import { checkFlow } from '../flow.js';
import { boot, bootLine, flowCtx, MemoryDb, runSteps } from '../testing.spec-helpers.js';

const WRITES = [
  Flow.create({ model: 'Ledger', values: {} }),
  Flow.createMany({ model: 'Ledger', rows: 'data.rows' }),
  Flow.update({ model: 'Ledger', where: { id: 1 }, values: {} }),
  Flow.destroy({ model: 'Ledger', where: { id: 1 } }),
  Flow.syncChildren({ model: 'Ledger', parent: { accountId: 1 }, key: 'branchId', values: 'data.ids' }),
];

describe('writes belong in before and after steps', () => {
  it.each(WRITES.map((step) => [step.kind, step]))('%s fails boot in a check step and binds before and after', (kind, step) => {
    expect(boot([step], 'check')).toThrow(new RegExp(`steps\\[0\\]: "${kind}" runs in before or after steps, not check`));
    expect(boot([step], 'before')).not.toThrow();
    expect(boot([step], 'after')).not.toThrow();
  });

  it('do not compile in a checkFlow, in the object or the builder form', () => {
    const compileOnly = (step: unknown) => void step;
    // @ts-expect-error create is a write
    compileOnly(() => checkFlow({ steps: [Flow.create({ model: 'L', values: {} })] }));
    // @ts-expect-error createMany is a write
    compileOnly(() => checkFlow({ steps: [{ kind: 'createMany', model: 'L', rows: 'data.rows' }] }));
    // @ts-expect-error update is a write
    compileOnly(() => checkFlow({ steps: [Flow.update({ model: 'L', where: { id: 1 }, values: {} })] }));
    // @ts-expect-error destroy is a write
    compileOnly(() => checkFlow({ steps: [{ kind: 'destroy', model: 'L', where: { id: 1 } }] }));
    // @ts-expect-error syncChildren is a write
    compileOnly(() => checkFlow({ steps: [Flow.syncChildren({ model: 'L', parent: { a: 1 }, key: 'k', values: 'data.ids' })] }));
  });
});

describe('create', () => {
  it('inserts one row from a map of expressions and names the saved row', async () => {
    const db = new MemoryDb({ Ledger: [] });
    const c = flowCtx(db, { row: { id: 4 }, dto: { amount: '10.5' } });
    await runSteps([Flow.create({ model: 'Ledger', values: { accountId: 'row.id', amount: 'data.amount * 2', note: "'opening'", posted: false }, as: 'ledger' }), Flow.state({ values: { id: 'ledger.id' } })], 'after', c);
    expect(db.tables.Ledger).toEqual([{ id: 1000, accountId: 4, amount: 21, note: 'opening', posted: false }]);
    expect(c.state).toEqual({ id: 1000 });
  });

  it('values may be one expression giving the whole object (built by a method); null gives an empty row', async () => {
    const db = new MemoryDb({ Ledger: [] });
    const c = flowCtx(db, { dto: { line: { a: 1, b: 'x' } } });
    await runSteps([Flow.create({ model: 'Ledger', values: 'data.line' }), Flow.create({ model: 'Ledger', values: 'data.none' })], 'before', c);
    expect(db.tables.Ledger).toEqual([{ id: 1000, a: 1, b: 'x' }, { id: 1001 }]);
    // A copy is written: the request object is not changed by the insert.
    expect(c.dto).toEqual({ line: { a: 1, b: 'x' } });
  });

  it('describes itself', () => {
    expect(bootLine([Flow.create({ model: 'Ledger', values: {} })], 'after')).toBe('create Ledger');
    expect(bootLine([Flow.create({ asSystem: true, model: 'Ledger', values: {} })], 'after')).toBe('[as system] create Ledger');
    expect(boot([Flow.create({ model: 'Ledger', values: { a: 'nope.x' } })], 'after')).toThrow(/unknown name "nope"/);
    expect(boot([Flow.create({ model: 'Ledger', values: 'nope' })], 'after')).toThrow(/unknown name "nope"/);
  });
});

describe('createMany', () => {
  it('each + as + values: one row per item, in order, in one insert; the saved rows named into', async () => {
    const db = new MemoryDb({ Charge: [] });
    const c = flowCtx(db, { dto: { charges: [{ name: 'Freight', amount: 10 }, { name: 'Packing', amount: '5' }] } });
    await runSteps(
      [
        Flow.createMany({ model: 'Charge', each: 'data.charges', as: 'charge', values: { name: 'charge.name', value: 'charge.amount + 0' }, into: 'saved' }),
        Flow.state({ values: { ids: "pluck(saved, 'id')", after: 'charge' } }),
      ],
      'after',
      c,
    );
    expect(db.tables.Charge).toEqual([{ id: 1000, name: 'Freight', value: 10 }, { id: 1001, name: 'Packing', value: 5 }]);
    expect(db.accessLog).toEqual(['createMany:Charge:caller']);
    // The item name is gone after the step.
    expect(c.state).toEqual({ ids: [1000, 1001], after: null });
  });

  it('rows: ready rows, copied so the request is not changed', async () => {
    const db = new MemoryDb({ Charge: [] });
    const rows = [{ name: 'A' }, { name: 'B' }];
    await runSteps([Flow.createMany({ model: 'Charge', rows: 'data.rows', into: 'saved' })], 'before', flowCtx(db, { dto: { rows } }));
    expect(db.tables.Charge).toEqual([{ id: 1000, name: 'A' }, { id: 1001, name: 'B' }]);
    expect(rows).toEqual([{ name: 'A' }, { name: 'B' }]);
  });

  it('an empty or missing list inserts nothing and names an empty list', async () => {
    const db = new MemoryDb({ Charge: [] });
    const c = flowCtx(db, { dto: {} });
    await runSteps([Flow.createMany({ model: 'Charge', rows: 'data.rows', into: 'a' }), Flow.createMany({ model: 'Charge', each: 'data.list', as: 'x', values: { n: 'x' }, into: 'b' }), Flow.state({ values: { a: 'a', b: 'b' } })], 'after', c);
    expect(db.calls).toEqual([]);
    expect(c.state).toEqual({ a: [], b: [] });
  });

  it('describes itself and needs rows, or each + as + values', () => {
    expect(bootLine([Flow.createMany({ model: 'Charge', each: 'data.list', as: 'x', values: { n: 'x' }, into: 'saved' })], 'after')).toBe('create Charge rows one per x in data.list (as saved)');
    expect(bootLine([Flow.createMany({ asSystem: true, model: 'Charge', rows: 'data.rows' })], 'after')).toBe('[as system] create Charge rows from data.rows');
    expect(boot([{ kind: 'createMany', model: 'Charge', each: 'data.list', values: {} }], 'after')).toThrow(/createMany needs rows, or each \+ as \+ values/);
    expect(boot([{ kind: 'createMany', model: 'Charge' }], 'after')).toThrow(/createMany needs rows/);
  });
});

describe('update', () => {
  const ledgers = () => new MemoryDb({ Ledger: [{ id: 1, accountId: 4, note: 'a' }, { id: 2, accountId: 4, note: 'b' }, { id: 3, accountId: 5, note: 'c' }] });

  it('changes the rows the where names, with a map of expressions', async () => {
    const db = ledgers();
    await runSteps([Flow.update({ model: 'Ledger', where: { accountId: 'row.id' }, values: { note: "upper(data.note)", posted: true } })], 'after', flowCtx(db, { row: { id: 4 }, dto: { note: 'x' } }));
    expect(db.tables.Ledger).toEqual([
      { id: 1, accountId: 4, note: 'X', posted: true },
      { id: 2, accountId: 4, note: 'X', posted: true },
      { id: 3, accountId: 5, note: 'c' },
    ]);
  });

  it('with one expression giving the values object', async () => {
    const db = ledgers();
    await runSteps([Flow.update({ model: 'Ledger', where: { id: 3 }, values: 'data.patch' })], 'before', flowCtx(db, { dto: { patch: { note: 'z', extra: 1 } } }));
    expect(db.tables.Ledger![2]).toEqual({ id: 3, accountId: 5, note: 'z', extra: 1 });
  });

  it('describes itself and never runs without a where', () => {
    expect(bootLine([Flow.update({ model: 'Ledger', where: { id: 1 }, values: { note: "'x'", posted: true } })], 'after')).toBe('update Ledger set note, posted');
    expect(bootLine([Flow.update({ asSystem: true, model: 'Ledger', where: { id: 1 }, values: 'data.patch' })], 'after')).toBe('[as system] update Ledger set data.patch');
    expect(boot([{ kind: 'update', model: 'Ledger', where: {}, values: {} }], 'after')).toThrow(/update needs a where \(it never changes every row\)/);
    expect(boot([{ kind: 'update', model: 'Ledger', values: {} }], 'after')).toThrow(/update needs a where/);
  });
});

describe('destroy', () => {
  it('removes the rows the where names', async () => {
    const db = new MemoryDb({ Ledger: [{ id: 1, accountId: 4 }, { id: 2, accountId: 5 }] });
    await runSteps([Flow.destroy({ model: 'Ledger', where: { accountId: 'row.id' } })], 'after', flowCtx(db, { row: { id: 4 } }));
    expect(db.tables.Ledger).toEqual([{ id: 2, accountId: 5 }]);
  });

  it('describes itself and never runs without a where', () => {
    expect(bootLine([Flow.destroy({ model: 'Ledger', where: { accountId: 'row.id', kind: "'x'" } })], 'after')).toBe('destroy Ledger where accountId, kind');
    expect(bootLine([Flow.destroy({ asSystem: true, model: 'Ledger', where: { id: 1 } })], 'after')).toBe('[as system] destroy Ledger where id');
    expect(boot([{ kind: 'destroy', model: 'Ledger', where: {} }], 'after')).toThrow(/destroy needs a where \(it never removes every row\)/);
  });
});

describe('syncChildren', () => {
  const links = () => new MemoryDb({ AccountBranch: [{ id: 1, accountId: 4, branchId: 1 }, { id: 2, accountId: 4, branchId: 2 }, { id: 3, accountId: 5, branchId: 1 }] });

  it('keeps the listed children, creates the missing ones with extra, removes the others; other parents untouched', async () => {
    const db = links();
    await runSteps([Flow.syncChildren({ model: 'AccountBranch', parent: { accountId: 'row.id' }, key: 'branchId', values: 'data.branches', extra: { isDefault: false } })], 'after', flowCtx(db, { row: { id: 4 }, dto: { branches: [2, 3] } }));
    expect(db.tables.AccountBranch).toEqual([
      { id: 2, accountId: 4, branchId: 2 },
      { id: 3, accountId: 5, branchId: 1 },
      { id: 1000, accountId: 4, isDefault: false, branchId: 3 },
    ]);
  });

  it('takes records ({ id }) as well as ids, and text ids equal to numbers', async () => {
    const db = links();
    await runSteps([Flow.syncChildren({ model: 'AccountBranch', parent: { accountId: 4 }, key: 'branchId', values: 'data.branches' })], 'after', flowCtx(db, { dto: { branches: [{ id: 1, name: 'HO' }, '2'] } }));
    expect(db.accessLog).toEqual(['findAll:AccountBranch:caller']);
  });

  it('an empty list removes every child of the parent', async () => {
    const db = links();
    await runSteps([Flow.syncChildren({ model: 'AccountBranch', parent: { accountId: 4 }, key: 'branchId', values: 'data.branches' })], 'after', flowCtx(db, { dto: { branches: [] } }));
    expect(db.tables.AccountBranch).toEqual([{ id: 3, accountId: 5, branchId: 1 }]);
  });

  // BUG: a value listed twice is created twice (`wanted` is not de-duplicated in syncChildren),
  // so `[3, 3]` leaves two children for branch 3. Fix: de-duplicate `wanted` by String(value)
  // (and drop null/undefined) before creating, as match does.
  it('a value listed twice gives one child', async () => {
    const db = new MemoryDb({ AccountBranch: [] });
    await runSteps([Flow.syncChildren({ model: 'AccountBranch', parent: { accountId: 4 }, key: 'branchId', values: 'data.branches' })], 'after', flowCtx(db, { dto: { branches: [3, 3] } }));
    expect(db.tables.AccountBranch).toHaveLength(1);
  });

  it('describes itself and needs parent and key', () => {
    expect(bootLine([Flow.syncChildren({ model: 'AccountBranch', parent: { accountId: 'row.id' }, key: 'branchId', values: 'data.branches' })], 'after')).toBe('sync AccountBranch.branchId under accountId to data.branches');
    expect(bootLine([Flow.syncChildren({ asSystem: true, model: 'A', parent: { p: 1 }, key: 'k', values: 'data.v' })], 'after')).toBe('[as system] sync A.k under p to data.v');
    expect(boot([{ kind: 'syncChildren', model: 'A', parent: {}, key: 'k', values: 'data.v' }], 'after')).toThrow(/syncChildren needs parent and key/);
    expect(boot([{ kind: 'syncChildren', model: 'A', parent: { p: 1 }, values: 'data.v' }], 'after')).toThrow(/syncChildren needs parent and key/);
  });
});
