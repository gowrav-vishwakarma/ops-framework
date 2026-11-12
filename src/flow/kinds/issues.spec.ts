import { describe, expect, it } from 'vitest';
import { Flow } from '../builtin-kinds.js';
import { boot, bootLine, flowCtx, MemoryDb, runSteps } from '../testing.spec-helpers.js';

describe('block', () => {
  it('in a check step joins the other issues, worded with the data', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { amount: -5 } });
    await runSteps([Flow.block({ code: 'negative', message: 'Amount {data.amount} is below zero' }), Flow.block({ message: 'second' })], 'check', c);
    expect(c.issues.blockers).toEqual([
      { code: 'negative', message: 'Amount -5 is below zero' },
      { code: 'blocked', message: 'second' },
    ]);
  });

  it('with field puts the message on that form field', async () => {
    const c = flowCtx();
    await runSteps([Flow.block({ message: 'too long', field: 'name' })], 'check', c);
    expect(c.issues.fields).toEqual({ name: ['too long'] });
    expect(c.issues.blockers).toEqual([]);
  });

  it('after the checks it stops at once with 422 and the same shape', async () => {
    for (const phase of ['before', 'after'] as const) {
      const c = flowCtx();
      const seen: string[] = [];
      const run = runSteps([Flow.block({ code: 'late', message: 'no' }), Flow.call({ method: 'mark' })], phase, c, { methods: { mark: () => void seen.push('ran') } });
      await expect(run).rejects.toMatchObject({ status: 422, response: { blockers: [{ code: 'late', message: 'no' }] } });
      expect(seen).toEqual([]);
    }
  });

  it('describes itself, needs a message, runs in every phase', () => {
    expect(bootLine([Flow.block({ message: 'Closed {data.x}' })])).toBe('block: Closed {data.x}');
    expect(boot([{ kind: 'block' }])).toThrow(/steps\[0\]: block needs a message/);
    expect(boot([{ kind: 'block', message: '' }])).toThrow(/block needs a message/);
    for (const phase of ['check', 'before', 'after'] as const) expect(boot([Flow.block({ message: 'x' })], phase)).not.toThrow();
  });
});

describe('warn', () => {
  it('asks for confirmation: a warning, not a blocker', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { qty: 900 } });
    await runSteps([Flow.warn({ message: 'Large quantity {data.qty}' }), Flow.warn({ code: 'big', message: 'again' })], 'check', c);
    expect(c.issues.warnings).toEqual([
      { code: 'confirm', message: 'Large quantity 900' },
      { code: 'big', message: 'again' },
    ]);
    expect(c.issues.failed).toBe(false);
  });

  it('belongs in check steps only, and describes itself', () => {
    expect(bootLine([Flow.warn({ message: 'Sure?' })])).toBe('warn: Sure?');
    expect(boot([Flow.warn({ message: 'x' })], 'before')).toThrow(/steps\[0\]: "warn" runs in check steps, not before/);
    expect(boot([Flow.warn({ message: 'x' })], 'after')).toThrow(/runs in check steps, not after/);
  });
});

describe('require', () => {
  it('puts a field error on every empty body field: missing, null, blank text', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { name: '  ', code: null, rate: 0, active: false, address: { city: '' } } });
    await runSteps([Flow.require({ fields: ['name', 'code', 'gstin', 'rate', 'active', 'address.city'] })], 'check', c);
    expect(c.issues.fields).toEqual({
      name: ['name is required'],
      code: ['code is required'],
      gstin: ['gstin is required'],
      'address.city': ['address.city is required'],
    });
  });

  it('takes its own message, a template', async () => {
    const c = flowCtx(new MemoryDb(), { dto: { kind: 'Truck' } });
    await runSteps([Flow.require({ fields: ['number'], message: 'A {data.kind} needs a number' })], 'check', c);
    expect(c.issues.fields).toEqual({ number: ['A Truck needs a number'] });
  });

  it('describes itself and needs fields', () => {
    expect(bootLine([Flow.require({ fields: ['name', 'code'] })])).toBe('require name, code');
    expect(boot([{ kind: 'require', fields: [] }])).toThrow(/require needs fields/);
    expect(boot([{ kind: 'require' }])).toThrow(/require needs fields/);
  });
});

describe('unique', () => {
  const charges = () => new MemoryDb({ Charge: [{ id: 1, name: 'Freight', code: 'FR' }, { id: 2, name: 'Packing', code: 'PK' }] });

  it('refuses a value another row has, on the field when there is one field', async () => {
    const c = flowCtx(charges(), { dto: { name: 'Packing' } });
    await runSteps([Flow.unique({ model: 'Charge', fields: ['name'] })], 'check', c);
    expect(c.issues.fields).toEqual({ name: ['name already exists'] });
  });

  it('does not count the record itself (an update keeping its name)', async () => {
    const c = flowCtx(charges(), { dto: { name: 'Packing' }, row: { id: 2, name: 'Packing' } });
    await runSteps([Flow.unique({ model: 'Charge', fields: ['name'] })], 'check', c);
    expect(c.issues.failed).toBe(false);
  });

  it('caseInsensitive compares lower-cased, trimmed text', async () => {
    const db = charges();
    const c = flowCtx(db, { dto: { name: '  FREIGHT ' } });
    await runSteps([Flow.unique({ model: 'Charge', fields: ['name'], caseInsensitive: true, message: 'Charge "{trim(data.name)}" already exists' })], 'check', c);
    expect(c.issues.fields).toEqual({ name: ['Charge "FREIGHT" already exists'] });
    const exact = flowCtx(charges(), { dto: { name: 'FREIGHT' } });
    await runSteps([Flow.unique({ model: 'Charge', fields: ['name'] })], 'check', exact);
    expect(exact.issues.failed).toBe(false);
  });

  it('several fields: the combination must be new; the issue is a blocker unless field names one', async () => {
    const c = flowCtx(charges(), { dto: { name: 'Freight', code: 'FR' } });
    await runSteps([Flow.unique({ model: 'Charge', fields: ['name', 'code'] })], 'check', c);
    expect(c.issues.blockers).toEqual([{ code: 'duplicate', message: 'name, code already exists' }]);
    const other = flowCtx(charges(), { dto: { name: 'Freight', code: 'XX' } });
    await runSteps([Flow.unique({ model: 'Charge', fields: ['name', 'code'], field: 'code' })], 'check', other);
    expect(other.issues.failed).toBe(false);
    const named = flowCtx(charges(), { dto: { name: 'Freight', code: 'FR' } });
    await runSteps([Flow.unique({ model: 'Charge', fields: ['name', 'code'], field: 'code' })], 'check', named);
    expect(named.issues.fields).toEqual({ code: ['name, code already exists'] });
  });

  it('prefers the record value over the body (a check after set sees the saved value)', async () => {
    const c = flowCtx(charges(), { dto: { name: 'New' }, row: { name: 'Freight' } });
    await runSteps([Flow.unique({ model: 'Charge', fields: ['name'] })], 'check', c);
    expect(c.issues.fields).toEqual({ name: ['name already exists'] });
  });

  it('counts across the whole tenant (as the system) and needs a model when the record is a plain object', async () => {
    const db = charges();
    await runSteps([Flow.unique({ model: 'Charge', fields: ['name'] })], 'check', flowCtx(db, { dto: { name: 'x' } }));
    expect(db.accessLog).toEqual(['count:Charge:system']);
    await expect(runSteps([Flow.unique({ fields: ['name'] })], 'check', flowCtx(db, { dto: { name: 'x' } }))).rejects.toThrow(/\[flow spec.ts unique\] unique needs `model` here/);
  });

  it('takes the model of the record being saved when no model is given', async () => {
    class Charge {
      constructor(readonly name: string) {}
    }
    const db = charges();
    const c = flowCtx(db, { dto: {}, row: new Charge('Packing') as never });
    await runSteps([Flow.unique({ fields: ['name'] })], 'check', c);
    expect(db.accessLog).toEqual(['count:Charge:system']);
    expect(c.issues.fields).toEqual({ name: ['name already exists'] });
  });

  it('describes itself, needs fields, works on records only, checks fields against the model', () => {
    expect(bootLine([Flow.unique({ fields: ['name', 'code'] })])).toBe('unique name + code');
    expect(bootLine([Flow.unique({ fields: ['name'], caseInsensitive: true })])).toBe('unique name (any case)');
    expect(boot([{ kind: 'unique', fields: [] }])).toThrow(/unique needs fields/);
    expect(boot([Flow.unique({ fields: ['name'] })], 'check', { op: 'list' })).toThrow(/"unique" works on records/);
    const model = { name: 'Charge', attributes: ['id', 'name'] };
    expect(boot([Flow.unique({ fields: ['nmae'] })], 'check', { model })).toThrow(/Charge has no field "nmae"/);
    // With an explicit model the fields belong to that model, not to the operation's.
    expect(boot([Flow.unique({ model: 'Other', fields: ['nmae'] })], 'check', { model })).not.toThrow();
  });
});

describe('notReferenced', () => {
  const db = () => new MemoryDb({ Trip: [{ id: 1, vehicleId: 7, status: 'open' }, { id: 2, vehicleId: 8, status: 'closed' }], Fuel: [] });

  it('refuses while another model points at the record, one blocker per probe that finds rows', async () => {
    const c = flowCtx(db(), { row: { id: 7 } });
    await runSteps([Flow.notReferenced({ probes: [{ model: 'Trip', field: 'vehicleId', message: 'Vehicle {row.id} has trips' }, { model: 'Fuel', field: 'vehicleId', message: 'has fuel' }] })], 'check', c);
    expect(c.issues.blockers).toEqual([{ code: 'in_use', message: 'Vehicle 7 has trips' }]);
  });

  it('a probe where narrows the rows that count; value and code replace row.id and in_use', async () => {
    const closedOnly = flowCtx(db(), { row: { id: 7 } });
    await runSteps([Flow.notReferenced({ probes: [{ model: 'Trip', field: 'vehicleId', where: { status: "'closed'" }, message: 'm' }] })], 'check', closedOnly);
    expect(closedOnly.issues.failed).toBe(false);
    const byValue = flowCtx(db(), { row: { id: 1 }, dto: { vehicle: 8 } });
    await runSteps([Flow.notReferenced({ value: 'data.vehicle', code: 'busy', probes: [{ model: 'Trip', field: 'vehicleId', message: 'm' }] })], 'check', byValue);
    expect(byValue.issues.blockers).toEqual([{ code: 'busy', message: 'm' }]);
  });

  it('counts as the system, describes itself, needs probes, works on records only', async () => {
    const memory = db();
    await runSteps([Flow.notReferenced({ probes: [{ model: 'Trip', field: 'vehicleId', message: 'm' }] })], 'check', flowCtx(memory, { row: { id: 99 } }));
    expect(memory.accessLog).toEqual(['count:Trip:system']);
    expect(bootLine([Flow.notReferenced({ probes: [{ model: 'Trip', field: 'vehicleId', message: 'm' }, { model: 'Fuel', field: 'vehicleId', message: 'm' }] })])).toBe('not referenced by Trip.vehicleId, Fuel.vehicleId');
    expect(boot([{ kind: 'notReferenced', probes: [] }])).toThrow(/notReferenced needs probes/);
    expect(boot([Flow.notReferenced({ probes: [{ model: 'T', field: 'f', message: 'm' }] })], 'check', { op: 'list-open' })).toThrow(/works on records/);
    expect(boot([Flow.notReferenced({ value: 'nope.id', probes: [{ model: 'T', field: 'f', message: 'm' }] })])).toThrow(/unknown name "nope"/);
  });
});
