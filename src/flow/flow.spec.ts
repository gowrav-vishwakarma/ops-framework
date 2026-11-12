import { describe, expect, it } from 'vitest';
import { fakeOpContext } from '../crud/testing/op-test.js';
import { FlowDb, type FlowAccess, type Row } from './flow-db.js';
import { defineStepKind, type FlowStep } from './kinds.js';
import { flow, runFlow } from './flow.js';

/** In-memory tables for flows: enough to see what the steps read and write. */
class MemoryDb extends FlowDb {
  constructor(readonly tables: Record<string, Row[]> = {}) {
    super();
  }
  private match(row: Row, where: Row): boolean {
    return Object.entries(where).every(([k, v]) => (v && typeof v === 'object' ? true : row[k] === v));
  }
  /** `kind:model -> system?` of every call, to see who each step acted as. */
  readonly accessLog: string[] = [];
  private log(kind: string, model: string, access: FlowAccess) {
    this.accessLog.push(`${kind}:${model}:${access.system ? 'system' : 'caller'}`);
  }
  hasModel = (model: string) => model in this.tables;
  findOne = async (_t: unknown, access: FlowAccess, model: string, where: Row) => (this.log('findOne', model, access), (this.tables[model] ?? []).find((r) => this.match(r, where)) ?? null);
  findAll = async (_t: unknown, access: FlowAccess, model: string, where: Row) => (this.log('findAll', model, access), (this.tables[model] ?? []).filter((r) => this.match(r, where)));
  count = async (_t: unknown, access: FlowAccess, model: string, where: object) => { this.log('count', model, access); 
    const and = (where as Record<symbol, unknown>)[Object.getOwnPropertySymbols(where)[0]!] as unknown[] | undefined;
    if (!and) return (this.tables[model] ?? []).filter((r) => this.match(r, where as Row)).length;
    return this.countedUnique ?? 0;
  };
  countedUnique: number | null = null;
  create = async (_t: unknown, access: FlowAccess, model: string, values: Row) => { this.log('create', model, access); 
    const row = { id: (this.tables[model]?.length ?? 0) + 1, ...values };
    (this.tables[model] ??= []).push(row);
    return row;
  };
  update = async (_t: unknown, access: FlowAccess, model: string, values: Row, where: Row) => { this.log('update', model, access); 
    const rows = (this.tables[model] ?? []).filter((r) => this.match(r, where));
    rows.forEach((r) => Object.assign(r, values));
    return rows.length;
  };
  destroy = async (_t: unknown, access: FlowAccess, model: string, where: Row) => { this.log('destroy', model, access); 
    const before = this.tables[model]?.length ?? 0;
    this.tables[model] = (this.tables[model] ?? []).filter((r) => !this.match(r, where) || Object.values(where).some((v) => v && typeof v === 'object' && !this.inList(r, where)));
    return before - this.tables[model].length;
  };
  private inList(row: Row, where: Row): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (!v || typeof v !== 'object') return row[k] === v;
      const list = (v as Record<symbol, unknown[]>)[Object.getOwnPropertySymbols(v)[0]!] ?? [];
      return list.map(String).includes(String(row[k]));
    });
  }
}

const ctx = (db: MemoryDb, options: Parameters<typeof fakeOpContext>[0] = {}) => fakeOpContext({ ...options, services: [[FlowDb, db]] });
const blockers = (c: ReturnType<typeof fakeOpContext>) => c.issues.blockers;
const fields = (c: ReturnType<typeof fakeOpContext>) => c.issues.fields;

describe('flows: step files as data', () => {
  it('require and block put issues on the operation in check steps', async () => {
    const db = new MemoryDb();
    const c = ctx(db, { dto: { name: '', amount: -1 } });
    await runFlow(flow({ steps: [{ kind: 'require', fields: ['name'] }, { kind: 'block', when: 'data.amount < 0', code: 'negative', message: 'Amount {data.amount} is below zero' }] }), 'check', c);
    expect(fields(c)).toEqual({ name: ['name is required'] });
    expect(blockers(c)).toEqual([expect.objectContaining({ code: 'negative', message: 'Amount -1 is below zero' })]);
  });

  it('unique refuses a duplicate, worded with the data', async () => {
    const db = new MemoryDb({ Charge: [] });
    db.countedUnique = 1;
    const c = ctx(db, { dto: { name: 'Freight' }, row: { id: 3, name: 'Freight' } });
    await runFlow(flow({ steps: [{ kind: 'unique', model: 'Charge', fields: ['name'], caseInsensitive: true, message: 'Charge "{data.name}" already exists' }] }), 'check', c);
    expect(fields(c)).toEqual({ name: ['Charge "Freight" already exists'] });
  });

  it('notReferenced blocks a delete while other rows point at the record', async () => {
    const db = new MemoryDb({ SalesInvoiceCharge: [{ id: 1, chargeId: 7 }] });
    const c = ctx(db, { row: { id: 7 } });
    await runFlow(flow({ steps: [{ kind: 'notReferenced', probes: [{ model: 'SalesInvoiceCharge', field: 'chargeId', message: 'Used in sales invoices' }] }] }), 'check', c);
    expect(blockers(c)).toEqual([expect.objectContaining({ code: 'in_use', message: 'Used in sales invoices' })]);
  });

  it('lookup, let, if and set compute values from related rows before the save', async () => {
    const db = new MemoryDb({ Branch: [{ id: 1, stateId: 27 }], Account: [{ id: 9, stateId: 29 }] });
    const c = ctx(db, { dto: { branchId: 1, partyId: 9 }, row: {} });
    const steps: FlowStep[] = [
      { kind: 'lookup', model: 'Branch', where: { id: 'data.branchId' }, as: 'branch', required: 'Branch not found' },
      { kind: 'lookup', model: 'Account', where: { id: 'data.partyId' }, as: 'party' },
      { kind: 'if', test: 'branch.stateId = party.stateId', then: [{ kind: 'set', values: { gstType: "'CGST_SGST'" } }], else: [{ kind: 'set', values: { gstType: "'IGST'" } }] },
    ];
    await runFlow(flow({ steps }), 'before', c);
    expect(c.row).toEqual({ gstType: 'IGST' });
  });

  it('a failing check outside the check phase stops at once with 422', async () => {
    const c = ctx(new MemoryDb({ Branch: [] }), { dto: { branchId: 5 } });
    await expect(runFlow(flow({ steps: [{ kind: 'lookup', model: 'Branch', where: { id: 'data.branchId' }, as: 'b', required: 'Branch {data.branchId} not found' }] }), 'after', c)).rejects.toMatchObject({ status: 422 });
  });

  it('writes: create, update, destroy and syncChildren, in after steps', async () => {
    const db = new MemoryDb({ AccountBranch: [{ id: 1, accountId: 4, branchId: 1 }, { id: 2, accountId: 4, branchId: 2 }], Ledger: [] });
    const c = ctx(db, { row: { id: 4 }, dto: { branches: [2, 3] } });
    await runFlow(
      flow({
        steps: [
          { kind: 'syncChildren', model: 'AccountBranch', parent: { accountId: 'row.id' }, key: 'branchId', values: 'data.branches' },
          { kind: 'create', model: 'Ledger', values: { accountId: 'row.id', note: "'opening'" }, as: 'ledger' },
          { kind: 'update', model: 'Ledger', where: { id: 'ledger.id' }, values: { note: "'opened'" } },
        ],
      }),
      'after',
      c,
    );
    expect(db.tables.AccountBranch!.map((r) => r.branchId).sort()).toEqual([2, 3]);
    expect(db.tables.Ledger).toEqual([{ id: 1, accountId: 4, note: 'opened' }]);
  });

  it('forEach and call: the code part lives in methods of the same file', async () => {
    const c = ctx(new MemoryDb(), { dto: { items: [{ qty: 2, rate: 5 }, { qty: 1, rate: '2.5' }] } });
    const seen: number[] = [];
    await runFlow(
      flow({
        steps: [{ kind: 'forEach', items: 'data.items', as: 'item', steps: [{ kind: 'call', method: 'collect', args: { amount: 'item.qty * item.rate' } }] }],
        methods: { collect: (_run, args) => void seen.push(args.amount as number) },
      }),
      'before',
      c,
    );
    expect(seen).toEqual([10, 2.5]);
  });

  it('a project kind reads like business: defineStepKind', async () => {
    defineStepKind({ name: 'testFyOpen' as never, run: async (run) => run.block('fy_closed', run.text('Financial year {fy(data.date)} is closed')), describe: () => 'financial year open' });
    const c = ctx(new MemoryDb(), { dto: { date: '2026-02-01' } });
    await runFlow(flow({ steps: [{ kind: 'testFyOpen' } as never] }), 'check', c);
    expect(blockers(c)[0]?.message).toBe('Financial year 2025-26 is closed');
  });

  it('fails at boot, naming the step: unknown kinds, wrong phase, bad expressions, missing methods', () => {
    const bind = (steps: unknown[], phase: 'check' | 'before' | 'after' = 'check', methods = {}) => () => flow({ steps: steps as FlowStep[], methods }).bindPhase(phase, { file: 'x.ts', op: 'create' });
    expect(bind([{ kind: 'nope' }])).toThrow(/steps\[0\]: unknown step kind "nope"/);
    expect(bind([{ kind: 'create', model: 'A', values: {} }])).toThrow(/runs in before or after steps, not check/);
    expect(bind([{ kind: 'let', values: { a: 'data.x +' } }])).toThrow(/steps\[0\]: "data.x \+"/);
    expect(bind([{ kind: 'call', method: 'missing' }], 'before')).toThrow(/no method "missing"/);
    expect(bind([{ kind: 'if', test: 'true', then: [{ kind: 'set', values: {} }] }], 'after')).toThrow(/steps\[0\]\.0\[0\]: "set" runs in before/);
    expect(bind([{ kind: 'where', values: {} }], 'before')).toThrow(/works on lists/);
  });

  it('data steps act as the caller unless asSystem; integrity checks see the whole tenant', async () => {
    const db = new MemoryDb({ Branch: [{ id: 1 }], Charge: [], Used: [] });
    const c = ctx(db, { dto: { name: 'X' }, row: { id: 1, name: 'X' } });
    await runFlow(
      flow({
        steps: [
          { kind: 'unique', model: 'Charge', fields: ['name'] },
          { kind: 'notReferenced', probes: [{ model: 'Used', field: 'chargeId', message: 'used' }] },
          { kind: 'lookup', model: 'Branch', where: { id: 1 }, as: 'b' },
          { kind: 'lookup', model: 'Branch', where: { id: 1 }, as: 'all', asSystem: true },
        ],
      }),
      'check',
      c,
    );
    expect(db.accessLog).toEqual(['count:Charge:system', 'count:Used:system', 'findOne:Branch:caller', 'findOne:Branch:system']);
  });

  it('an operation flow.ts groups steps by phase; each phase binds its own list', async () => {
    const file = flow({
      check: [{ kind: 'require', fields: ['name'] }],
      before: [{ kind: 'set', values: { code: "upper(data.name)" } }],
    });
    expect(file.phases()).toEqual(['check', 'before']);
    const c = ctx(new MemoryDb(), { dto: { name: 'frt' }, row: {} });
    await runFlow(file, 'check', c);
    await runFlow(file, 'before', c);
    expect(c.issues.failed).toBe(false);
    expect(c.row).toEqual({ code: 'FRT' });
    expect(() => file.bindPhase('after', { file: 'flow.ts', op: 'save' })).toThrow(/no after steps/);
    expect(() => flow({ steps: [], check: [] })).toThrow(/either `steps`/);
    expect(() => flow({})).toThrow(/needs `steps`/);
    // @ts-expect-error `set` changes the record: the compiler refuses it under `check`; boot does too.
    expect(() => flow({ check: [{ kind: 'set', values: {} }] }).bindPhase('check', { file: 'flow.ts', op: 'save' })).toThrow(/check\[0\]: "set" runs in before/);
  });

  it('names fields of the model: typed with flow<Model>, checked against the model at boot', () => {
    interface Charge {
      id: number;
      name: string;
      defaultValue: number;
    }
    flow<Charge>({ check: [{ kind: 'unique', fields: ['name'] }], before: [{ kind: 'set', values: { defaultValue: 'round(row.defaultValue, 2)' } }] });
    // @ts-expect-error a typo in a field name does not compile
    flow<Charge>({ check: [{ kind: 'unique', fields: ['nmae'] }] });
    // @ts-expect-error a kind that does not exist does not compile
    flow<Charge>({ check: [{ kind: 'uniq', fields: ['name'] }] });
    const model = { name: 'Charge', attributes: ['id', 'name', 'defaultValue'] };
    const bind = (file: ReturnType<typeof flow>, phase: 'check' | 'before') => () => file.bindPhase(phase, { file: 'flow.ts', op: 'save', model });
    expect(bind(flow({ check: [{ kind: 'unique', fields: ['nmae'] }] }), 'check')).toThrow(/check\[0\]: Charge has no field "nmae"/);
    expect(bind(flow({ check: [{ kind: 'block', when: 'row.defualtValue < 0', message: 'x' }] }), 'check')).toThrow(/Charge has no field "defualtValue"/);
    expect(bind(flow({ before: [{ kind: 'set', values: { colour: "'red'" } }] }), 'before')).toThrow(/Charge has no field "colour"/);
    expect(bind(flow({ check: [{ kind: 'block', when: 'row.defaultValue < 0 and data.anything = 1', message: 'x' }] }), 'check')).not.toThrow();
  });

  it('describes itself for the flow document', () => {
    const bound = flow({ steps: [{ kind: 'require', fields: ['name'] }, { kind: 'unique', fields: ['name'], caseInsensitive: true, when: 'data.name is not empty' }] }).bindPhase('check', { file: 'x', op: 'save' });
    expect(bound.describe).toBe('require name; unique name (any case) (when data.name is not empty)');
  });
});
