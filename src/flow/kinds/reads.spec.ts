import { describe, expect, it } from 'vitest';
import { Flow } from '../builtin-kinds.js';
import { boot, bootLine, flowCtx, MemoryDb, runSteps } from '../testing.spec-helpers.js';

const branches = () => new MemoryDb({ Branch: [{ id: 1, name: 'HO', stateId: 27, gstin: null }, { id: 2, name: 'Pune', stateId: 27, gstin: '27AAA' }, { id: 3, name: 'Goa', stateId: 30, gstin: null }] });

describe('lookup', () => {
  it('names one row; later steps read its fields', async () => {
    const c = flowCtx(branches(), { dto: { branchId: 2 } });
    await runSteps([Flow.lookup({ model: 'Branch', where: { id: 'data.branchId' }, as: 'branch' }), Flow.state({ values: { stateId: 'branch.stateId', name: 'branch.name' } })], 'check', c);
    expect(c.state).toEqual({ stateId: 27, name: 'Pune' });
  });

  it('names null when nothing matches; required blocks with its template', async () => {
    const c = flowCtx(branches(), { dto: { branchId: 9 } });
    await runSteps(
      [Flow.lookup({ model: 'Branch', where: { id: 'data.branchId' }, as: 'branch', required: 'Branch {data.branchId} not found' }), Flow.state({ values: { found: 'branch is not null' } })],
      'check',
      c,
    );
    expect(c.issues.blockers).toEqual([{ code: 'not_found', message: 'Branch 9 not found' }]);
    expect(c.state).toEqual({ found: false });
  });

  it('passes the field list and literal values through to the query', async () => {
    const db = branches();
    await runSteps([Flow.lookup({ model: 'Branch', where: { stateId: 30, name: "'Goa'" }, fields: ['id'], as: 'b' })], 'check', flowCtx(db));
    expect(db.calls[0]).toMatchObject({ kind: 'findOne', where: { stateId: 30, name: 'Goa' }, options: ['id'] });
  });

  it('a where value that is literally undefined finds nothing without querying', async () => {
    const db = branches();
    const c = flowCtx(db);
    await runSteps([Flow.lookup({ model: 'Branch', where: { id: undefined }, as: 'b', required: 'missing' })], 'check', c);
    expect(db.calls).toEqual([]);
    expect(c.issues.blockers).toEqual([{ code: 'not_found', message: 'missing' }]);
  });

  // BUG: an expression never gives `undefined` (evaluate turns a missing name into null), so
  // `hasMissing` in builtin-kinds.ts never sees one: the lookup queries `gstin IS NULL` and finds a
  // branch that has no GSTIN, the opposite of "a condition on a value that is not there finds nothing".
  // Fix: in lookup/find (and match's where), treat a null that came from an expression
  // (`typeof arg === 'string'`) as missing; keep a literal `null` argument as IS NULL.
  it('a where expression naming a missing value finds nothing without querying', async () => {
    const db = branches();
    const c = flowCtx(db, { dto: {} });
    await runSteps([Flow.lookup({ model: 'Branch', where: { gstin: 'data.gstin' }, as: 'b' }), Flow.state({ values: { found: 'b is not null' } })], 'check', c);
    expect(c.state).toEqual({ found: false });
    expect(db.calls).toEqual([]);
  });

  it('describes itself, shows asSystem, needs model, where and as, checks its expressions', () => {
    expect(bootLine([Flow.lookup({ model: 'Branch', where: { id: 'data.branchId', stateId: 27 }, as: 'branch' })])).toBe('branch = Branch where id = data.branchId and stateId = 27');
    expect(bootLine([Flow.lookup({ asSystem: true, model: 'Branch', where: { id: 1 }, as: 'b' })])).toBe('[as system] b = Branch where id = 1');
    expect(boot([{ kind: 'lookup', model: 'Branch', where: {} }])).toThrow(/lookup needs model, where and as/);
    expect(boot([{ kind: 'lookup', where: {}, as: 'b' }])).toThrow(/lookup needs model, where and as/);
    expect(boot([Flow.lookup({ model: 'B', where: { id: 'data.id +' }, as: 'b' })])).toThrow(/steps\[0\]: "data.id \+"/);
    for (const phase of ['check', 'before', 'after'] as const) expect(boot([Flow.lookup({ model: 'B', where: { id: 1 }, as: 'b' })], phase)).not.toThrow();
    expect(boot([Flow.lookup({ model: 'B', where: { id: 1 }, as: 'b' })], 'before', { op: 'list' })).not.toThrow();
  });
});

describe('find', () => {
  it('names the matching rows, at most limit, with the fields asked', async () => {
    const db = branches();
    const c = flowCtx(db);
    await runSteps([Flow.find({ model: 'Branch', where: { stateId: 27 }, as: 'rows', fields: ['id', 'name'], limit: 1 }), Flow.state({ values: { n: 'count(rows)', names: "pluck(rows, 'name')" } })], 'check', c);
    expect(c.state).toEqual({ n: 1, names: ['HO'] });
    expect(db.calls[0]).toMatchObject({ kind: 'findAll', options: { attributes: ['id', 'name'], limit: 1 } });
  });

  it('names an empty list when nothing matches', async () => {
    const c = flowCtx(branches());
    await runSteps([Flow.find({ model: 'Branch', where: { stateId: 99 }, as: 'rows' }), Flow.state({ values: { n: 'count(rows)' } })], 'check', c);
    expect(c.state).toEqual({ n: 0 });
  });

  it('a literally undefined where value finds nothing without querying', async () => {
    const db = branches();
    const c = flowCtx(db);
    await runSteps([Flow.find({ model: 'Branch', where: { stateId: undefined }, as: 'rows' }), Flow.state({ values: { rows: 'rows' } })], 'check', c);
    expect(db.calls).toEqual([]);
    expect(c.state).toEqual({ rows: [] });
  });

  // BUG: same as lookup: `data.stateId` missing evaluates to null, find queries `stateId IS NULL`.
  it('a where expression naming a missing value finds nothing without querying', async () => {
    const db = branches();
    await runSteps([Flow.find({ model: 'Branch', where: { gstin: 'data.gstin' }, as: 'rows' })], 'check', flowCtx(db, { dto: {} }));
    expect(db.calls).toEqual([]);
  });

  it('describes itself and needs model, where and as', () => {
    expect(bootLine([Flow.find({ model: 'Trip', where: { vehicleId: 'row.id' }, as: 'trips' })])).toBe('trips = Trip rows where vehicleId = row.id');
    expect(bootLine([Flow.find({ asSystem: true, model: 'Trip', where: { vehicleId: 'row.id' }, as: 'trips' })])).toBe('[as system] trips = Trip rows where vehicleId = row.id');
    expect(boot([{ kind: 'find', model: 'Trip', as: 'x' }])).toThrow(/find needs model, where and as/);
  });
});

describe('match', () => {
  const serials = () =>
    new MemoryDb({
      Serial: [
        { id: 1, code: 'C3', status: 'in' },
        { id: 2, code: 'A1', status: 'in' },
        { id: 3, code: 'B2', status: 'out' },
      ],
    });

  it('splits a list into the rows a model has and the values it has not, missing in the list order', async () => {
    const c = flowCtx(serials(), { dto: { codes: ['Z9', 'A1', 'B2', 'Y8', 'C3'] } });
    await runSteps([Flow.match({ model: 'Serial', field: 'code', values: 'data.codes', where: { status: "'in'" }, as: 'inStock', missing: 'notInStock' }), Flow.state({ values: { found: "pluck(inStock, 'code')", missing: 'notInStock' } })], 'check', c);
    expect(c.state.missing).toEqual(['Z9', 'B2', 'Y8']);
    expect([...(c.state.found as string[])].sort()).toEqual(['A1', 'C3']);
  });

  // BUG (or doc to fix): the kind's doc says the rows found and the missing values come "in the
  // list's order", but `as` holds the rows in the order the database returned them (C3 before A1
  // here). Fix: order `rows` by the position of row[field] in `wanted` before naming them.
  it('names the rows found in the order of the list', async () => {
    const c = flowCtx(serials(), { dto: { codes: ['A1', 'C3'] } });
    await runSteps([Flow.match({ model: 'Serial', field: 'code', values: 'data.codes', as: 'found' }), Flow.state({ values: { found: "pluck(found, 'code')" } })], 'check', c);
    expect(c.state.found).toEqual(['A1', 'C3']);
  });

  it('asks once for each distinct value, skipping nulls; 1 and "1" are the same value', async () => {
    const db = new MemoryDb({ Item: [{ id: 1, code: 1 }] });
    const c = flowCtx(db, { dto: { codes: [1, '1', null, 2, 2, 'x', 'x'] } });
    await runSteps([Flow.match({ model: 'Item', field: 'code', values: 'data.codes', as: 'found', missing: 'gone' }), Flow.state({ values: { gone: 'gone', n: 'count(found)' } })], 'check', c);
    expect(db.calls[0]!.where).toMatchObject({ code: expect.anything() });
    const asked = Object.values(db.calls[0]!.where as Record<string, Record<symbol, unknown[]>>)[0]!;
    expect(asked[Object.getOwnPropertySymbols(asked)[0]!]).toEqual([1, 2, 'x']);
    expect(c.state).toEqual({ gone: [2, 'x'], n: 1 });
  });

  it('an empty or missing list asks nothing and names empty lists', async () => {
    const db = serials();
    const c = flowCtx(db, { dto: {} });
    await runSteps([Flow.match({ model: 'Serial', field: 'code', values: 'data.codes', as: 'found', missing: 'gone' }), Flow.state({ values: { found: 'found', gone: 'gone' } })], 'check', c);
    expect(db.calls).toEqual([]);
    expect(c.state).toEqual({ found: [], gone: [] });
  });

  it('describes itself, needs model, field, values and as', () => {
    expect(bootLine([Flow.match({ model: 'Serial', field: 'code', values: 'data.codes', where: { status: "'in'" }, as: 'inStock', missing: 'out' })])).toBe(
      "inStock = Serial rows whose code is in data.codes and status = 'in'; out = the values with no such row",
    );
    expect(bootLine([Flow.match({ asSystem: true, model: 'Serial', field: 'code', values: 'data.codes', as: 'x' })])).toBe('[as system] x = Serial rows whose code is in data.codes');
    expect(boot([{ kind: 'match', model: 'Serial', values: 'data.codes', as: 'x' }])).toThrow(/match needs model, field, values and as/);
  });
});
