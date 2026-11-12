import { describe, expect, it } from 'vitest';
import { Flow } from '../builtin-kinds.js';
import { boot, bootLine, flowCtx, MemoryDb, runSteps } from '../testing.spec-helpers.js';

describe('let', () => {
  it('names values for later steps, each one able to read the ones before', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { qty: 3, rate: '12.50' } });
    await runSteps([Flow.let({ values: { gross: 'data.qty * data.rate', net: 'gross - 2.5', flag: true, none: null } }), Flow.state({ values: { gross: 'gross', net: 'net', flag: 'flag', none: 'none' } })], 'check', c);
    expect(c.state).toEqual({ gross: 37.5, net: 35, flag: true, none: null });
  });

  it('describes itself, runs in every phase, checks its expressions', () => {
    expect(bootLine([Flow.let({ values: { total: 'data.a + 1', on: true } })])).toBe('let total = data.a + 1, on = true');
    for (const phase of ['check', 'before', 'after'] as const) expect(boot([Flow.let({ values: { a: '1' } })], phase)).not.toThrow();
    expect(boot([Flow.let({ values: { a: 'b + 1' } })])).toThrow(/unknown name "b"/);
  });
});

describe('state', () => {
  it('puts values on c.state for later step files, keeping what is there', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { a: 2 }, state: { kept: 1 } });
    await runSteps([Flow.state({ values: { doubled: 'data.a * 2', label: "'x'" } })], 'after', c);
    expect(c.state).toEqual({ kept: 1, doubled: 4, label: 'x' });
  });

  it('describes itself by the names it sets', () => {
    expect(bootLine([Flow.state({ values: { total: '1', count: '2' } })])).toBe('state total, count');
  });
});

describe('assign', () => {
  it('writes values into the request and the state by path, making the objects on the way', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { items: [1, 2], meta: 'text' }, state: {} });
    await runSteps([Flow.assign({ values: { 'data.gstType': "'igst'", 'data.summary.count': 'count(data.items)', 'data.meta.x': '1', 'state.deep.er.v': 'true' } })], 'before', c);
    expect(c.dto).toEqual({ items: [1, 2], gstType: 'igst', summary: { count: 2 }, meta: { x: 1 } });
    expect(c.state).toEqual({ deep: { er: { v: true } } });
  });

  it('describes itself and refuses paths outside data and state', () => {
    expect(bootLine([Flow.assign({ values: { 'data.a': '1', 'state.b': "'x'" } })])).toBe("data.a = 1, state.b = 'x'");
    expect(boot([Flow.assign({ values: { 'row.x': '1' } })])).toThrow(/assign: "row.x" must be a path under data or state/);
    expect(boot([Flow.assign({ values: { data: '1' } })])).toThrow(/"data" must be a path under data or state/);
    expect(boot([Flow.assign({ values: { 'user.id': '1' } })])).toThrow(/must be a path under data or state/);
  });

  // BUG: assign follows any key of its path, so a path through `__proto__` writes into
  // Object.prototype (every object of the process then has `polluted`). Paths come from flow
  // files, not requests, but nothing refuses them. Fix: refuse `__proto__`, `prototype` and
  // `constructor` segments in assign's validate, and walk with `Object.hasOwn` in run.
  it('refuses a path through __proto__ at boot', () => {
    expect(boot([Flow.assign({ values: { 'data.__proto__.polluted': "'yes'" } })], 'before')).toThrow();
  });

  it('never writes through __proto__ into Object.prototype', async () => {
    try {
      await runSteps([Flow.assign({ values: { 'data.__proto__.polluted': "'yes'" } })], 'before', flowCtx());
    } catch {
      // Refusing the path is a fix too.
    }
    const polluted = ({} as Record<string, unknown>).polluted;
    delete (Object.prototype as Record<string, unknown>).polluted;
    expect(polluted).toBeUndefined();
  });
});

describe('set', () => {
  /** A model-like record: attributes come from `getAttributes`, values through get/set. */
  class Charge {
    static getAttributes = () => ({ id: {}, name: {}, rate: {}, code: {} });
    readonly values: Record<string, unknown> = {};
    get(key: string) {
      return this.values[key];
    }
    set(key: string, value: unknown) {
      this.values[key] = value;
    }
  }

  it('sets fields of the record being saved, through the model setter', async () => {
    const row = new Charge();
    const c = flowCtx(new MemoryDb(), { dto: { name: ' frt ' }, row: row as never });
    await runSteps([Flow.set({ values: { name: 'upper(trim(data.name))', rate: 5 } })], 'before', c);
    expect(row.values).toEqual({ name: 'FRT', rate: 5 });
  });

  it('from copies every field of the model an object has; values then override', async () => {
    const row = new Charge();
    const c = flowCtx(new MemoryDb(), { dto: { name: 'Freight', rate: '10', code: 'FR', notAField: 1, id: 99 }, row: row as never });
    await runSteps([Flow.set({ from: 'data', values: { code: 'lower(data.code)' } })], 'before', c);
    expect(row.values).toEqual({ id: 99, name: 'Freight', rate: '10', code: 'fr' });
  });

  it('from a missing object copies nothing', async () => {
    const row = new Charge();
    await runSteps([Flow.set({ from: 'data.nothing' })], 'before', flowCtx(new MemoryDb(), { dto: {}, row: row as never }));
    expect(row.values).toEqual({});
  });

  it('runs before the save only, on records only; describes itself; needs values or from', () => {
    expect(bootLine([Flow.set({ from: 'data', values: { code: "'x'" } })], 'before')).toBe("set the fields of data, code = 'x'");
    expect(boot([Flow.set({ values: { a: '1' } })], 'check')).toThrow(/"set" runs in before steps, not check/);
    expect(boot([Flow.set({ values: { a: '1' } })], 'after')).toThrow(/"set" runs in before steps, not after/);
    expect(boot([Flow.set({ values: { a: '1' } })], 'before', { op: 'list' })).toThrow(/"set" works on records/);
    expect(boot([{ kind: 'set' }], 'before')).toThrow(/set needs values or from/);
    expect(boot([Flow.set({ values: { colour: "'red'" } })], 'before', { model: { name: 'Charge', attributes: ['id', 'name'] } })).toThrow(/Charge has no field "colour"/);
  });
});
