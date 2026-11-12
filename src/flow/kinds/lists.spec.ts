import { describe, expect, it } from 'vitest';
import { Flow } from '../builtin-kinds.js';
import { boot, bootLine, flowCtx, MemoryDb, runSteps } from '../testing.spec-helpers.js';

const LIST = { file: 'list/410-before-open.ts', op: 'list' };

describe('where (list before steps)', () => {
  it('adds a condition to the query, its values evaluated', async () => {
    const where: unknown[] = [{ companyId: 1 }];
    await runSteps([Flow.where({ values: { status: "'open'", branchId: 'user.branchId' } })], 'before', flowCtx(new MemoryDb(), { where, user: { branchId: 3 } }), { place: LIST });
    expect(where).toEqual([{ companyId: 1 }, { status: 'open', branchId: 3 }]);
  });

  it('fails when the context has no query to add to', async () => {
    await expect(runSteps([Flow.where({ values: { a: '1' } })], 'before', flowCtx(), { place: LIST })).rejects.toThrow(/where works in list steps/);
  });

  it('runs in before steps of lists only, and describes itself', () => {
    expect(bootLine([Flow.where({ values: { status: "'open'" } })], 'before', { op: 'list-open' })).toBe("where status = 'open'");
    expect(boot([Flow.where({ values: {} })], 'before', { op: 'save' })).toThrow(/"where" works on lists/);
    expect(boot([Flow.where({ values: {} })], 'after', { op: 'list' })).toThrow(/"where" runs in before steps, not after/);
    expect(boot([Flow.where({ values: {} })], 'check', { op: 'list' })).toThrow(/runs in before steps, not check/);
  });
});

describe('decorate (list after steps)', () => {
  /** A model-like row: values go through setDataValue. */
  class Trip {
    readonly dataValues: Record<string, unknown>;
    constructor(values: Record<string, unknown>) {
      this.dataValues = { ...values };
    }
    get(key: string) {
      return this.dataValues[key];
    }
    setDataValue(key: string, value: unknown) {
      this.dataValues[key] = value;
    }
  }

  it('puts values on every row: plain objects get fields, models setDataValue', async () => {
    const rows = [{ id: 1, km: 10 }, new Trip({ id: 2, km: 5 })];
    await runSteps([Flow.decorate({ values: { tag: "'x'", flagged: 'state.flag' } })], 'after', flowCtx(new MemoryDb(), { rows, state: { flag: true } }), { place: LIST });
    expect(rows[0]).toEqual({ id: 1, km: 10, tag: 'x', flagged: true });
    expect((rows[1] as Trip).dataValues).toEqual({ id: 2, km: 5, tag: 'x', flagged: true });
  });

  it('no rows: nothing to do', async () => {
    await expect(runSteps([Flow.decorate({ values: { tag: "'x'" } })], 'after', flowCtx(), { place: LIST })).resolves.toBeUndefined();
  });

  it('runs in after steps of lists only, and describes itself', () => {
    expect(bootLine([Flow.decorate({ values: { tag: "'x'", label: "'y'" } })], 'after', { op: 'list' })).toBe('decorate rows with tag, label');
    expect(boot([Flow.decorate({ values: {} })], 'before', { op: 'list' })).toThrow(/"decorate" runs in after steps, not before/);
    expect(boot([Flow.decorate({ values: {} })], 'after', { op: 'update' })).toThrow(/"decorate" works on lists/);
  });

  // BUG: the kind's doc says "`item` is the row", and run() names it, but `item` is not a declared
  // name (decorate has no `names()`), so the boot check refuses every expression that reads it:
  // `unknown name "item"`. Fix: give the decorate kind `names: () => ['item']`.
  it('reads each row as item', async () => {
    const rows = [{ id: 1, km: 10 }, { id: 2, km: 5 }];
    await runSteps([Flow.decorate({ values: { long: 'item.km > 8' } })], 'after', flowCtx(new MemoryDb(), { rows }), { place: LIST });
    expect(rows).toEqual([{ id: 1, km: 10, long: true }, { id: 2, km: 5, long: false }]);
  });
});
