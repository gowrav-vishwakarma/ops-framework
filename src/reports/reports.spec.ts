import { Sequelize } from 'sequelize-typescript';
import { describe, expect, it } from 'vitest';
import { ExpressionError } from '../expr/parse.js';
import { compileSql, SqlBinder } from '../expr/sql.js';
import { buildReportCatalog } from './catalog.js';
import { compileStages, ReportCompileError, type ReportScope } from './compiler.js';
import type { Rdl2EngineStage, Rdl2PeriodsStage, Rdl2Report, Rdl2StageBase } from './language.js';
import { reportLimits, RunGate } from './limits.js';
import { periodLabel, resolvePeriods } from './periods.js';
import { bareOutput, outputNeeds, pruneReport } from './prune.js';
import { groupPageInMemory } from './runner.js';
import { SAMPLE_MODELS } from './samples/models.js';
import { lineMargin, SAMPLE_REPORTS, stockSummary, type SampleMarginStage } from './samples/reports.js';
import { defineReportEngine, defineReportStage, ENGINE_STAGE, StageError } from './stages.js';
import { groupedRunSql } from './summary.js';

type Report = Rdl2Report<Rdl2StageBase>;

// The sample project's own parts, as a project registers them at boot.
defineReportEngine('sampleCreditUsed', {
  columns: ['creditUsed'],
  keys: 1,
  figures: async (keys) => keys.map((key) => ({ k0: key.k0, creditUsed: 100 })),
});
defineReportStage<SampleMarginStage>({
  kind: 'margin',
  added(stage, input) {
    if (!input.includes(stage.product)) throw new StageError(`has no column "${stage.product}"`);
    return ['cost', 'margin'];
  },
  reads: (stage) => [stage.product, stage.amount],
  keysSql: (stage, chain, sql) => `${chain.withSql}\nSELECT DISTINCT (f.${sql.quote(stage.product)})::bigint AS "k" FROM ${chain.from} f`,
  work: async (keys) => keys.map((key) => ({ k: key.k, c: 0.6 })),
  joinSql: (stage, from, figures, sql) =>
    `SELECT f.*, (${sql.expr(stage.amount)}) * c."c" AS "cost", (${sql.expr(stage.amount)}) * (1 - c."c") AS "margin" FROM ${from} f LEFT JOIN (SELECT * FROM jsonb_to_recordset(CAST(${figures} AS jsonb)) AS x("k" bigint, "c" numeric)) c ON c."k" = (f.${sql.quote(stage.product)})::bigint`,
});

/** The sample models, offline: the catalog reads metadata only, nothing connects. */
function sampleCatalog() {
  const sequelize = new Sequelize({ dialect: 'postgres', logging: false, database: 'x', username: 'x', password: 'x' });
  sequelize.addModels(SAMPLE_MODELS);
  return buildReportCatalog(sequelize.models as never, { softDeleteFlags: [] }, { field: 'branchId', free: ['Branch', 'Party', 'Product', 'Category'] });
}

function defaults(report: Report): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const param of report.params) out[param.id] = param.type === 'date' ? '2026-04-01' : param.type === 'number' ? 0 : param.multi ? [] : null;
  return out;
}

describe('reports', () => {
  const catalog = sampleCatalog();
  const scope: ReportScope = { tenantSchema: 'tenant_x', companyId: 7, rowIds: [1, 2] };
  const compile = (report: Report, params = defaults(report), binder = new SqlBinder(), figures?: Map<string, string>) => compileStages(report, { catalog, scope, params, binder, figures });

  it('reads the models: attributes with their columns, relations, company, row scope and soft delete', () => {
    const invoice = catalog.models.Invoice!;
    expect(invoice.table).toBe('invoices');
    expect(invoice.fields.find((field) => field.name === 'invoiceDate')).toMatchObject({ column: 'invoice_date', type: 'date', label: 'Invoice date' });
    expect(invoice.fields.find((field) => field.name === 'status')).toMatchObject({ type: 'enum', values: ['draft', 'posted', 'cancelled'] });
    expect(invoice.scope).toEqual({ company: 'company_id', row: 'own', rowColumn: 'branch_id', rowColumns: ['branch_id'], softDelete: { column: 'deleted_at', kind: 'timestamp' } });
    expect(invoice.relations.map((relation) => `${relation.name}:${relation.type}`).sort()).toEqual(['branch:one', 'lines:many', 'party:one']);
    // A line reaches its branch through the header it is named after; a shared master is not scoped.
    expect(catalog.models.InvoiceLine!.scope).toMatchObject({ row: 'path', rowPath: 'invoice' });
    expect(catalog.models.Party!.scope.row).toBe('none');
    // Secrets never reach a report.
    expect(catalog.models.Party!.fields.some((field) => field.name === 'portalPassword')).toBe(false);
  });

  it.each(SAMPLE_REPORTS.map((report) => [report.name, report] as const))('compiles the sample %s', (_name, report) => {
    const binder = new SqlBinder();
    const compiled = compile(report, defaults(report), binder);
    const out = compiled.columns.get(report.output.stage)!;
    for (const column of report.output.columns) expect(out, `${report.name}: ${column.column}`).toContain(column.column);
    // Every read is scoped: company on every table, deleted invoices out; values are bound, never in the SQL text.
    expect(compiled.withSql).toMatch(/"company_id" = :p\d+/);
    expect(compiled.withSql).not.toContain('2026-04-01');
    if (report.stages.some((stage) => stage.kind === 'source' && (stage as { model: string }).model === 'Invoice')) expect(compiled.withSql).toContain('"deleted_at" IS NULL');
  });

  it('narrows by the row scope: own column, or through the header for a line; shared masters stay whole', () => {
    const sql = compile(SAMPLE_REPORTS.find((report) => report.name === 'sample.party.summary')!).withSql;
    expect(sql).toMatch(/LEFT JOIN "tenant_x"\."invoices" t1 ON t1\."id" = t0\."invoice_id"/);
    expect(sql).toMatch(/t1\."branch_id" IN \(:p\d+\)/);
    const register = compileStages(SAMPLE_REPORTS[0]!, { catalog, scope: { ...scope, rowIds: [] }, params: defaults(SAMPLE_REPORTS[0]!), binder: new SqlBinder() });
    // Nothing allowed reads nothing.
    expect(register.withSql).toMatch(/t0\."branch_id" IN \(:p\d+\)/);
    const idle = compile(SAMPLE_REPORTS.find((report) => report.name === 'sample.party.idle')!).withSql;
    expect(idle.split('FROM "tenant_x"."parties"')[1]!.split('),')[0]).not.toContain('branch_id');
  });

  /*
   * A model scoped by more than one column (a transfer: from and to branch), any of them enough
   * (`rowScope.fields`); its lines reach both through their header. A model with no scope at all (not shared, no
   * column, no path) is read whole unless `rowScope.unscoped: 'refuse'` makes a missing mapping fail closed.
   */
  it('narrows a model by any of several columns, and its lines through the header; refuses an unscoped model when asked', () => {
    const sequelize = new Sequelize({ dialect: 'postgres', logging: false, database: 'x', username: 'x', password: 'x' });
    sequelize.addModels(SAMPLE_MODELS);
    const rowScope = { field: 'branchId', free: ['Branch', 'Party', 'Product', 'Category'], fields: { Transfer: ['fromBranchId', 'toBranchId'] } };
    const multi = buildReportCatalog(sequelize.models as never, { softDeleteFlags: [] }, rowScope);
    expect(multi.models.Transfer!.scope).toMatchObject({ row: 'own', rowColumns: ['from_branch_id', 'to_branch_id'] });
    expect(multi.models.TransferLine!.scope).toMatchObject({ row: 'path', rowPath: 'transfer' });
    expect(multi.models.Memo!.scope.row).toBe('none');

    const source = (model: string, path: string): Report => ({ lang: 'rdl2', name: `t.${model}`, title: model, category: 'Test', params: [], stages: [{ kind: 'source', id: 'rows', model, fields: [{ as: 'x', path }] }] }) as never;
    const run = (catalog: typeof multi, report: Report, rowIds: number[] | null) => compileStages(report, { catalog, scope: { ...scope, rowIds }, params: {}, binder: new SqlBinder() }).withSql;
    const either = /\(t0\."from_branch_id" IN \([^)]*\) OR t0\."to_branch_id" IN \([^)]*\)\)/;
    expect(run(multi, source('Transfer', 'sentOn'), [1, 2])).toMatch(either);
    expect(run(multi, source('TransferLine', 'qty'), [1, 2])).toMatch(/\(t1\."from_branch_id" IN \([^)]*\) OR t1\."to_branch_id" IN \([^)]*\)\)/);
    expect(run(multi, source('Transfer', 'sentOn'), null)).not.toContain('from_branch_id" IN');

    // Not mapped: read whole (as before) unless refused; a user of every branch reads it either way.
    expect(run(multi, source('Memo', 'text'), [1])).toContain('"memos"');
    const strict = buildReportCatalog(sequelize.models as never, { softDeleteFlags: [] }, { ...rowScope, unscoped: 'refuse' as const });
    expect(() => run(strict, source('Memo', 'text'), [1])).toThrow(ReportCompileError);
    expect(() => run(strict, source('Memo', 'text'), [1])).toThrow(/Memo.*not limited to branches|not limited/i);
    expect(run(strict, source('Memo', 'text'), null)).toContain('"memos"');
    expect(run(strict, source('Party', 'name'), [1])).toContain('"parties"');
  });

  it('works a project stage kind out in code: empty until the runner has the figures, then joined back', () => {
    const pending = compile(lineMargin as Report);
    expect(pending.pending.map((stage) => stage.id)).toEqual(['costed']);
    expect(pending.columns.get('costed')).toEqual(['productId', 'product', 'qty', 'amount', 'cost', 'margin']);
    const filled = compile(lineMargin as Report, defaults(lineMargin as Report), new SqlBinder(), new Map([['costed', '[{"k":1,"c":0.6}]']]));
    expect(filled.pending).toEqual([]);
    expect(filled.withSql).toContain('jsonb_to_recordset');
    // Its own checks name the stage.
    const broken = { ...lineMargin, stages: lineMargin.stages.map((stage) => (stage.id === 'costed' ? { ...stage, product: 'gone' } : stage)) } as Report;
    expect(() => compile(broken)).toThrow(/costed: has no column "gone"/);
    // Nothing reads its columns: pruned away, nothing to work out.
    const lean = pruneReport(lineMargin as Report, ['product', 'sales'], pending.columns);
    expect(compile(lean).pending).toEqual([]);
    // A core kind's name cannot be taken.
    expect(() => defineReportStage({ ...ENGINE_STAGE, kind: 'source' } as never)).toThrow(/stage kind of the framework/);
  });

  it('asks a named engine for figures by key; engines are for shipped reports only', () => {
    const report = SAMPLE_REPORTS.find((item) => item.name === 'sample.party.credit')!;
    const compiled = compile(report);
    expect(compiled.pending.map((stage) => stage.kind)).toEqual(['engine']);
    expect(compiled.columns.get('used')).toContain('creditUsed');
    expect(ENGINE_STAGE.shippedOnly).toBe(true);
    // Its keys query binds the engine's args by name, inputs resolved.
    const asOn: Rdl2EngineStage = { kind: 'engine', id: 'e', from: 'x', name: 'sampleCreditUsed', keys: ['id'], args: { asOn: '@asOn', mode: 'all' } };
    expect(ENGINE_STAGE.bindings!(asOn, { asOn: '2026-05-01' })).toEqual({ asOn: '2026-05-01', mode: 'all' });
    const unknown = { ...report, stages: report.stages.map((stage) => (stage.kind === 'engine' ? { ...stage, name: 'nope' } : stage)) } as Report;
    expect(() => compile(unknown)).toThrow(/used: has no engine "nope"/);
  });

  it('prunes what nothing shows, keeping keys so rows and totals do not change', () => {
    const full = compile(stockSummary);
    const lean = pruneReport(stockSummary, ['product', 'closing'], full.columns);
    const sql = compile(lean).withSql;
    // The rate join is not needed for closing; the balance keys stay.
    expect(sql).not.toContain('"value"');
    expect(sql).toContain('"opening"');
    const needed = outputNeeds(bareOutput(stockSummary.output), { columns: ['product', 'value'] }, full.columns.get('out')!)!;
    expect([...needed].sort()).toEqual(['product', 'value']);
  });

  it('refuses names outside the catalog, many-relations in a row, and anything that is not a name', () => {
    const one = (fields: { as: string; path: string }[], where?: string): Report => ({
      lang: 'rdl2',
      name: 'bad',
      title: 'Bad',
      params: [],
      stages: [{ kind: 'source', id: 's', model: 'Invoice', fields, ...(where ? { where } : {}) }],
      output: { stage: 's', columns: [] },
    });
    expect(() => compile(one([{ as: 'x', path: 'nope' }]))).toThrow(ReportCompileError);
    expect(() => compile(one([{ as: 'x', path: 'lines.qty' }]))).toThrow(/holds many rows per Invoice/);
    expect(() => compile(one([{ as: 'x"; drop', path: 'id' }]))).toThrow(/not a valid name/);
    expect(() => compile(one([{ as: 'x', path: 'id' }], 'id = 1; drop table x'))).toThrow();
    expect(() => compile({ ...one([{ as: 'x', path: 'id' }]), stages: [{ kind: 'source', id: 's', model: 'Nope', fields: [{ as: 'x', path: 'id' }] }] })).toThrow(/not a model a report can read/);
  });

  it('filters by a tree: a picked category and every category under it', () => {
    const report = SAMPLE_REPORTS.find((item) => item.name === 'sample.product.top')!;
    const picked = compile(report, { ...defaults(report), categories: [5] });
    expect(picked.withSql).toMatch(/IN \(SELECT c\."id" FROM "tenant_x"\."categories" c WHERE EXISTS .*c\."left" >= p\."left" AND c\."right" <= p\."right"/);
    // Nothing picked filters nothing.
    expect(compile(report, { ...defaults(report), categories: [] }).withSql).not.toContain('"categories" c');
    const notTree = { ...report, params: report.params.map((param) => (param.id === 'categories' ? { ...param, lookup: { model: 'Branch', label: 'name' } } : param)) };
    expect(() => compile(notTree, { ...defaults(report), categories: [1] })).toThrow(/needs a lookup on a tree/);
  });

  it('works out comparison periods: last year, months back, the previous span, a series', () => {
    const stage = (periods: Rdl2PeriodsStage['periods']): Rdl2PeriodsStage => ({ kind: 'periods', id: 'p', from: 'x', date: 'd', periodFrom: '@from', periodTo: '@to', periods });
    const at = (from: string, to: string, periods: Rdl2PeriodsStage['periods']) => resolvePeriods(stage(periods), { from, to }).map((period) => `${period.name} ${period.from}..${period.to}`);
    expect(at('2026-04-01', '2026-08-26', [{ name: 'cur' }, { name: 'ly', shiftYears: -1 }])).toEqual(['cur 2026-04-01..2026-08-26', 'ly 2025-04-01..2025-08-26']);
    // A whole month stays a whole month, leap years included.
    expect(at('2024-02-01', '2024-02-29', [{ name: 'ly', shiftYears: -1 }, { name: 'pm', shiftMonths: -1 }])).toEqual(['ly 2023-02-01..2023-02-28', 'pm 2024-01-01..2024-01-31']);
    // The previous span of the same length: a quarter before a quarter, else as many days.
    expect(at('2026-07-01', '2026-09-30', [{ name: 'prev', previous: true }])).toEqual(['prev 2026-04-01..2026-06-30']);
    expect(at('2026-08-11', '2026-08-20', [{ name: 'prev', previous: true }])).toEqual(['prev 2026-08-01..2026-08-10']);
    expect(at('2026-08-01', '2026-08-31', [{ name: 'now' }, { name: 'y', shiftYears: -1, repeat: 2 }])).toEqual(['now 2026-08-01..2026-08-31', 'y1 2025-08-01..2025-08-31', 'y2 2024-08-01..2024-08-31']);
    expect(periodLabel('FY-{fy} Upto {toMonth}', '2026-04-01', '2026-08-26')).toBe('FY-2026-27 Upto Aug-26');
    expect(() => resolvePeriods(stage([{ name: 'a' }, { name: 'a', shiftYears: -1 }]), { from: '2026-04-01', to: '2026-05-01' })).toThrow(/Two periods/);
    // Compiled: rows join the list of periods, and the source before reads the whole span.
    const report = SAMPLE_REPORTS.find((item) => item.name === 'sample.sales.year-on-year')!;
    const binder = new SqlBinder();
    const compiled = compile(report, { from: '2026-04-01', to: '2026-08-26' }, binder);
    expect(compiled.columns.get('span')).toEqual(['party', 'day', 'total', 'period']);
    expect(compiled.withSql).toMatch(/INNER JOIN \(VALUES .*\) AS p\("n", "pf", "pt"\)/);
    expect(Object.values(binder.replacements)).toEqual(expect.arrayContaining(['2025-04-01', '2026-08-26', 'now', 'last']));
    expect(compiled.periods.map((period) => period.label)).toEqual(['FY 2026-27', 'FY 2025-26']);
  });

  it('groups a pivot run on the server: keys, date buckets, sums and counts, in a stable order', () => {
    const known = new Set(['date', 'kind', 'amount', 'party']);
    const formats = new Map<string, Report['output']['columns'][number]['format']>([['date', 'date'], ['amount', 'money']]);
    const { sql, columns } = groupedRunSql('SELECT * FROM "st_out"', { keys: [{ column: 'kind' }, { column: 'date', bucket: 'fy' }], values: ['amount', 'party', 'kind'] }, known, formats, { limit: 50000, offset: 50000 });
    expect(columns).toEqual(['kind', 'date', 'amount', 'party']);
    expect(sql).toContain(`(date_trunc('year', ("date")::date - interval '3 months') + interval '3 months')::date AS "date"`);
    expect(sql).toContain('SUM("amount") AS "amount", COUNT("amount") AS "amount__n", MIN("amount") AS "amount__min", MAX("amount") AS "amount__max"');
    // A text value is counted, not summed; a key is not totalled again.
    expect(sql).toContain('COUNT("party") AS "party__n"');
    expect(sql).not.toContain('SUM("party")');
    expect(sql).not.toContain('"kind__n"');
    expect(sql).toMatch(/GROUP BY 1, 2\) g ORDER BY "kind" ASC NULLS LAST, "date" ASC NULLS LAST LIMIT 50000 OFFSET 50000$/);
    expect(() => groupedRunSql('SELECT 1', { keys: [{ column: 'nope' }], values: [] }, known, formats, { limit: 1, offset: 0 })).toThrow('does not have: nope');
  });

  it('pages whole groups in memory, numbered as they first appear', () => {
    const rows = [
      { party: 'A', bill: 1 },
      { party: 'A', bill: 2 },
      { party: 'B', bill: 3 },
      { party: null, bill: 4 },
      { party: 'C', bill: 5 },
      { party: 'C', bill: 6 },
    ];
    const first = groupPageInMemory(rows, ['party'], 0, 2);
    expect(first.groups).toBe(4);
    expect(first.rows.map((row) => row.bill)).toEqual([1, 2, 3]);
    expect(groupPageInMemory(rows, ['party'], 2, 2).rows.map((row) => row.bill)).toEqual([4, 5, 6]);
    expect(groupPageInMemory(rows, ['party'], 4, 2).rows).toEqual([]);
  });

  it('takes run limits from the project, ignoring bad values', () => {
    expect(reportLimits()).toEqual({ timeoutMs: 30000, workMem: null, maxRuns: 3 });
    expect(reportLimits({ timeoutMs: 60000, workMem: '32MB', maxRuns: 5 })).toEqual({ timeoutMs: 60000, workMem: { text: '32MB', bytes: 32 * 1024 * 1024 }, maxRuns: 5 });
    // Out of range or not a size: the safe default, never unbounded.
    expect(reportLimits({ timeoutMs: 0, workMem: '4GB', maxRuns: 500 })).toEqual({ timeoutMs: 30000, workMem: null, maxRuns: 3 });
    expect(reportLimits({ workMem: '16MB; drop table x' }).workMem).toBeNull();
  });

  it('lets only so many runs through at once', async () => {
    const gate = new RunGate(2);
    let running = 0;
    let most = 0;
    const job = () =>
      gate.run(1000, () => new Error('busy'), async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return true;
      });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(most).toBe(2);
    // A waiter gives up after its wait.
    const slow = new RunGate(1);
    const holder = slow.run(1000, () => new Error('busy'), () => new Promise((resolve) => setTimeout(resolve, 100)));
    await expect(slow.run(10, () => new Error('busy'), async () => true)).rejects.toThrow('busy');
    await holder;
  });

  it('compiles expressions to bound SQL and rejects anything outside the language', () => {
    const binder = new SqlBinder();
    const sql = compileSql("amount > 1000 and name contains 'a%b' and branchId in @b and if(x < 0, -x, 0) >= 5", { name: (n) => `"${n}"`, param: () => [3, 4], binder });
    expect(sql).toContain('ILIKE');
    expect(sql).toContain('IN (:p');
    expect(Object.values(binder.replacements)).toEqual(expect.arrayContaining([1000, '%a\\%b%', [3, 4], 5]));
    expect(sql).not.toContain('1000');
    const ctx = { name: (n: string) => `"${n}"`, param: () => null, binder: new SqlBinder() };
    expect(() => compileSql('pg_sleep(10)', ctx)).toThrow(ExpressionError);
    expect(() => compileSql('a; select 1', ctx)).toThrow(ExpressionError);
    expect(() => compileSql("a = 'x", ctx)).toThrow(ExpressionError);
  });
});
