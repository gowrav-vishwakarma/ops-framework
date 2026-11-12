import { InternalServerErrorException, Logger, UnprocessableEntityException } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Flow } from '../builtin-kinds.js';
import type { FlowMethod } from '../run.js';
import { boot, bootLine, flowCtx, MemoryDb, runSteps } from '../testing.spec-helpers.js';

/** A method that records its arguments under a label. */
const recorder = () => {
  const seen: unknown[] = [];
  const note: FlowMethod = (_run, args) => void seen.push(args.v);
  return { seen, methods: { note } };
};

describe('if / else', () => {
  it('runs then when the test is true, else otherwise; null (a missing value) is not true', async () => {
    for (const [amount, expected] of [[5, 'big'], [1, 'small'], [undefined, 'small']] as const) {
      const { seen, methods } = recorder();
      const c = flowCtx(new MemoryDb(), { dto: { amount } });
      await runSteps([Flow.if({ test: 'data.amount > 2', then: [Flow.call({ method: 'note', args: { v: "'big'" } })], else: [Flow.call({ method: 'note', args: { v: "'small'" } })] })], 'check', c, { methods });
      expect(seen).toEqual([expected]);
    }
  });

  it('without else does nothing when the test is false', async () => {
    const { seen, methods } = recorder();
    await runSteps([Flow.if({ test: 'false', then: [Flow.call({ method: 'note', args: { v: '1' } })] })], 'check', flowCtx(), { methods });
    expect(seen).toEqual([]);
  });

  it('describes itself with its branches indented; nested steps are checked with the same phase', () => {
    expect(bootLine([Flow.if({ test: 'data.a = 1', then: [Flow.block({ message: 'x' })], else: [Flow.warn({ message: 'y' })] })])).toBe('if data.a = 1 (else ...);   block: x;   warn: y');
    expect(boot([Flow.if({ test: 'true', then: [Flow.block({ message: 'x' })], else: [Flow.set({ values: {} })] })], 'check')).toThrow(/steps\[0\]\.1\[0\]: "set" runs in before/);
    expect(boot([Flow.if({ test: 'data.a +', then: [] })])).toThrow(/steps\[0\]: "data.a \+"/);
  });
});

describe('forEach', () => {
  it('runs the steps once per item, the item named as; the name is gone after the loop', async () => {
    const { seen, methods } = recorder();
    const c = flowCtx(new MemoryDb(), { dto: { items: [{ qty: 2, rate: 5 }, { qty: 1, rate: '2.5' }] } });
    await runSteps([Flow.forEach({ items: 'data.items', as: 'item', steps: [Flow.call({ method: 'note', args: { v: 'item.qty * item.rate' } })] }), Flow.state({ values: { after: 'item' } })], 'before', c, { methods });
    expect(seen).toEqual([10, 2.5]);
    expect(c.state).toEqual({ after: null });
  });

  it('a missing list runs nothing; a value that is not a list fails', async () => {
    const { seen, methods } = recorder();
    await runSteps([Flow.forEach({ items: 'data.none', as: 'x', steps: [Flow.call({ method: 'note', args: { v: 'x' } })] })], 'before', flowCtx(), { methods });
    expect(seen).toEqual([]);
    await expect(runSteps([Flow.forEach({ items: 'data.n', as: 'x', steps: [] })], 'before', flowCtx(new MemoryDb(), { dto: { n: 5 } }))).rejects.toThrow(/\[flow spec.ts forEach\] forEach: data.n is not a list/);
  });

  it('stop inside ends the loop and the flow', async () => {
    const { seen, methods } = recorder();
    await runSteps(
      [Flow.forEach({ items: 'data.items', as: 'x', steps: [Flow.stop({ when: 'x = 2' }), Flow.call({ method: 'note', args: { v: 'x' } })] }), Flow.call({ method: 'note', args: { v: "'after'" } })],
      'before',
      flowCtx(new MemoryDb(), { dto: { items: [1, 2, 3] } }),
      { methods },
    );
    expect(seen).toEqual([1]);
  });

  it('describes itself and needs as and steps', () => {
    expect(bootLine([Flow.forEach({ items: 'data.items', as: 'item', steps: [Flow.block({ message: 'm', when: 'item.qty < 0' })] })])).toBe('for each item in data.items;   block: m (when item.qty < 0)');
    expect(boot([{ kind: 'forEach', items: 'data.items', steps: [] }])).toThrow(/forEach needs as and steps/);
  });

  // BUG (boot message): a nested list that is missing (`forEach` without steps, `if` without then,
  // `try` without steps) crashes `declaredNames` in flow.ts with "list is not iterable", without
  // the file's step position. Fix: skip lists that are not arrays in `declaredNames` (and in
  // `check`, which already says "steps must be a list"), and validate `if.then` / `try.steps`.
  it('a missing nested list fails boot with the step position', () => {
    expect(boot([{ kind: 'forEach', items: 'data.items', as: 'x' }])).toThrow(/steps\[0\]/);
    expect(boot([{ kind: 'if', test: 'true' }])).toThrow(/steps\[0\]/);
    expect(boot([{ kind: 'try' }])).toThrow(/steps\[0\]/);
  });
});

describe('try', () => {
  afterEach(() => vi.restoreAllMocks());

  /** A context whose savepoint keeps a copy of the table and puts it back when the work fails. */
  const withSavepoint = (db: MemoryDb, options: Parameters<typeof flowCtx>[1] = {}) => {
    const c = flowCtx(db, options);
    const savepoints: string[] = [];
    c.savepoint = async <T,>(work: (t: Transaction) => Promise<T>): Promise<T> => {
      const copy = structuredClone(db.tables);
      savepoints.push('open');
      try {
        return await work(c.t);
      } catch (error) {
        for (const key of Object.keys(db.tables)) delete db.tables[key];
        Object.assign(db.tables, copy);
        savepoints.push('rolled back');
        throw error;
      }
    };
    return { c, savepoints };
  };

  it('a failure that is not the user\'s is logged and undoes only the work inside', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const db = new MemoryDb({ Ledger: [] });
    const { c, savepoints } = withSavepoint(db);
    await runSteps(
      [
        Flow.create({ model: 'Ledger', values: { note: "'kept'" } }),
        Flow.try({ steps: [Flow.create({ model: 'Ledger', values: { note: "'undone'" } }), Flow.call({ method: 'boom' })] }),
        Flow.create({ model: 'Ledger', values: { note: "'after'" } }),
      ],
      'after',
      c,
      { methods: { boom: () => { throw new Error('mail server down'); } } },
    );
    expect(db.tables.Ledger!.map((r) => r.note)).toEqual(['kept', 'after']);
    expect(savepoints).toEqual(['open', 'rolled back']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/spec.ts: optional steps failed and were undone: \[flow spec.ts call\] mail server down/));
  });

  it('a 5xx HTTP error is not a refusal: swallowed too', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { c } = withSavepoint(new MemoryDb());
    await expect(runSteps([Flow.try({ steps: [Flow.call({ method: 'boom' })] })], 'after', c, { methods: { boom: () => { throw new InternalServerErrorException('x'); } } })).resolves.toBeUndefined();
  });

  it('a 4xx refusal is rethrown: a block, or an HTTP 4xx from code', async () => {
    const db = new MemoryDb({ Ledger: [] });
    const { c } = withSavepoint(db);
    await expect(runSteps([Flow.try({ steps: [Flow.create({ model: 'Ledger', values: {} }), Flow.block({ message: 'no' })] })], 'after', c)).rejects.toMatchObject({ status: 422 });
    expect(db.tables.Ledger).toEqual([]);
    const other = withSavepoint(new MemoryDb());
    await expect(runSteps([Flow.try({ steps: [Flow.call({ method: 'refuse' })] })], 'after', other.c, { methods: { refuse: () => { throw new UnprocessableEntityException('bad input'); } } })).rejects.toThrow('bad input');
    const status = withSavepoint(new MemoryDb());
    await expect(runSteps([Flow.try({ steps: [Flow.call({ method: 'refuse' })] })], 'after', status.c, { methods: { refuse: () => { throw Object.assign(new Error('gone'), { status: 404 }); } } })).rejects.toThrow('gone');
  });

  it('stop inside ends the flow', async () => {
    const { seen, methods } = recorder();
    const { c } = withSavepoint(new MemoryDb());
    await runSteps([Flow.try({ steps: [Flow.stop()] }), Flow.call({ method: 'note', args: { v: '1' } })], 'after', c, { methods });
    expect(seen).toEqual([]);
  });

  it('without a savepoint on the context it still runs and swallows', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const c = flowCtx();
    delete (c as { savepoint?: unknown }).savepoint;
    const { seen, methods } = recorder();
    await runSteps([Flow.try({ steps: [Flow.call({ method: 'note', args: { v: '1' } }), Flow.call({ method: 'boom' })] }), Flow.call({ method: 'note', args: { v: '2' } })], 'after', c, {
      methods: { ...methods, boom: () => { throw new Error('x'); } },
    });
    expect(seen).toEqual([1, 2]);
  });

  it('describes itself and checks its steps', () => {
    expect(bootLine([Flow.try({ steps: [Flow.create({ model: 'L', values: {} })] })], 'after')).toBe('try (a failure undoes only these steps);   create L');
    expect(boot([Flow.try({ steps: [Flow.create({ model: 'L', values: {} })] })], 'check')).toThrow(/steps\[0\]\.0\[0\]: "create" runs in before or after/);
  });
});

describe('stop', () => {
  it('ends this flow file; steps after it do not run', async () => {
    const { seen, methods } = recorder();
    await runSteps([Flow.call({ method: 'note', args: { v: '1' } }), Flow.stop(), Flow.call({ method: 'note', args: { v: '2' } })], 'check', flowCtx(), { methods });
    expect(seen).toEqual([1]);
  });

  it('inside if ends the whole flow, not only the branch', async () => {
    const { seen, methods } = recorder();
    await runSteps([Flow.if({ test: 'true', then: [Flow.stop()] }), Flow.call({ method: 'note', args: { v: '2' } })], 'check', flowCtx(), { methods });
    expect(seen).toEqual([]);
  });

  it('describes itself and runs in every phase', () => {
    expect(bootLine([Flow.stop()])).toBe('stop');
    for (const phase of ['check', 'before', 'after'] as const) expect(boot([Flow.stop()], phase)).not.toThrow();
  });
});

describe('call', () => {
  it('runs a method of the file with evaluated arguments and names its result', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { a: 2, b: '3' } });
    await runSteps([Flow.call({ method: 'add', args: { a: 'data.a', b: 'data.b', literal: 7 }, as: 'sum' }), Flow.state({ values: { sum: 'sum' } })], 'check', c, {
      methods: { add: async (run, args) => ({ total: Number(args.a) + Number(args.b) + Number(args.literal), op: run.c.op }) },
    });
    expect(c.state).toEqual({ sum: { total: 12, op: 'test' } });
  });

  it('a method error is rethrown with the file and kind', async () => {
    await expect(runSteps([Flow.call({ method: 'boom' })], 'check', flowCtx(), { methods: { boom: () => { throw new Error('nope'); } } })).rejects.toThrow('[flow spec.ts call] nope');
  });

  it('describes itself and needs a method of the file', () => {
    expect(bootLine([Flow.call({ method: 'split', args: { a: '1' }, as: 'parts' })], 'check', {}, { split: () => 1 })).toBe('call split()');
    expect(boot([Flow.call({ method: 'missing' })])).toThrow(/steps\[0\]: no method "missing" in this flow/);
  });

  // BUG: the boot check is `!methods[name]`, so names every object inherits pass it:
  // `constructor` calls `Object(run)` and names the FlowRun itself (its context, transaction and
  // user then readable from expressions); `toString`, `hasOwnProperty` too. Fix: check with
  // `Object.hasOwn(methods, name)` in flow.ts and look methods up the same way in the call kind.
  it('refuses names an object inherits (constructor, toString) as methods', () => {
    expect(boot([Flow.call({ method: 'constructor' })])).toThrow(/no method "constructor"/);
    expect(boot([Flow.call({ method: 'toString' })])).toThrow(/no method "toString"/);
  });
});
