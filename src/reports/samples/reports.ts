import type { Rdl2Param, Rdl2Report, Rdl2StageBase } from '../language.js';

/**
 * Sample reports on the sample models (`models.ts`): one per stage kind and output feature, compiled by
 * `samples.spec.ts` so they never go stale. Read them with `docs/reports.md`; copy one as the start of a real report.
 *
 * A report is `params` (the viewer's inputs, `@id` in expressions) → `stages` (each reads an earlier one by `from`)
 * → `output` (which stage, its columns, totals, groups, cards). Names are model attributes and relation paths,
 * never table or column names, and expressions are the small language of `expr/` (no SQL).
 */

/** The period every dated sample takes: the user's financial year by default (`fyStart` / `fyEnd`). */
const PERIOD: Rdl2Param[] = [
  { id: 'from', label: 'From', type: 'date', required: true, default: 'fyStart' },
  { id: 'to', label: 'To', type: 'date', required: true, default: 'fyEnd' },
];

/** Branch input: `branchScope` narrows the user's row scope to the picked branches (never widens it). */
const BRANCHES: Rdl2Param = { id: 'branches', label: 'Branches', type: 'lookup', multi: true, lookup: { model: 'Branch', label: 'name' }, branchScope: true };

/** A party picker: the viewer may show its own party lookup (`preset`); the run gets ids either way. */
const PARTY: Rdl2Param = { id: 'party', label: 'Party', type: 'lookup', multi: true, lookup: { model: 'Party', label: 'name', preset: 'party' } };

/**
 * 1. A register: `source` reads a model with fields through belongs-to relations (`party.name`); its `where` is an
 * expression over fields and paths. Output: formats, a drill to the record, sort, totals, cards, page size.
 */
export const invoiceRegister: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.invoice.register',
  title: 'Invoice Register',
  category: 'Sales',
  params: [...PERIOD, BRANCHES, PARTY, { id: 'status', label: 'Status', type: 'select', multi: true, options: [{ value: 'posted', label: 'Posted' }, { value: 'draft', label: 'Draft' }] }],
  stages: [
    {
      kind: 'source',
      id: 'invoices',
      model: 'Invoice',
      fields: [
        { as: 'id', path: 'id' },
        { as: 'date', path: 'invoiceDate' },
        { as: 'number', path: 'number' },
        { as: 'party', path: 'party.name' },
        { as: 'city', path: 'party.city' },
        { as: 'branch', path: 'branch.name' },
        { as: 'status', path: 'status' },
        { as: 'total', path: 'total' },
      ],
      where: 'invoiceDate between @from and @to and partyId in @party and status in @status',
    },
  ],
  output: {
    stage: 'invoices',
    columns: [
      { column: 'date', label: 'Date', format: 'date' },
      { column: 'number', label: 'Invoice', drill: { voucher: { type: 'invoice', id: 'id' } } },
      { column: 'party', label: 'Party', caption: 'city' },
      { column: 'branch', label: 'Branch', quiet: true },
      { column: 'status', label: 'Status', hidden: true },
      { column: 'total', label: 'Total', format: 'money', tone: 'info' },
    ],
    sort: [{ column: 'date', dir: 'desc' }],
    totals: ['total'],
    cards: [{ column: 'total', label: 'Sales', tone: 'success' }],
    pageSize: 50,
  },
  menu: { show: true, group: 'Sales', order: 1 },
};

/**
 * 2. A summary per party: `aggregate` groups and measures (`sum`, `count`, a measure with its own `where`), `having`
 * keeps groups; `derive` adds a computed column; a column `total` is a formula over the totals (never summed).
 */
export const partySummary: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.party.summary',
  title: 'Sales by Party',
  category: 'Sales',
  params: [...PERIOD, { id: 'least', label: 'At least', type: 'number', default: 0 }],
  stages: [
    {
      kind: 'source',
      id: 'lines',
      model: 'InvoiceLine',
      fields: [
        { as: 'party', path: 'invoice.party.name' },
        { as: 'invoice', path: 'invoiceId' },
        { as: 'qty', path: 'qty' },
        { as: 'amount', path: 'amount' },
      ],
      where: "invoice.invoiceDate between @from and @to and invoice.status = 'posted'",
    },
    {
      kind: 'aggregate',
      id: 'byParty',
      from: 'lines',
      groupBy: ['party'],
      measures: [
        { as: 'invoices', fn: 'countDistinct', expr: 'invoice' },
        { as: 'qty', fn: 'sum', expr: 'qty' },
        { as: 'sales', fn: 'sum', expr: 'amount' },
        { as: 'bigLines', fn: 'count', where: 'amount >= 10000' },
      ],
      having: 'sales >= @least',
    },
    { kind: 'derive', id: 'out', from: 'byParty', columns: [{ as: 'perInvoice', expr: 'round(sales / invoices, 2)' }] },
  ],
  output: {
    stage: 'out',
    columns: [
      { column: 'party', label: 'Party' },
      { column: 'invoices', label: 'Invoices', format: 'number' },
      { column: 'qty', label: 'Qty', format: 'qty' },
      { column: 'sales', label: 'Sales', format: 'money' },
      { column: 'perInvoice', label: 'Per invoice', format: 'money', total: 'sales / invoices' },
      { column: 'bigLines', label: 'Lines ≥ 10,000', format: 'number', quiet: true },
    ],
    sort: [{ column: 'sales', dir: 'desc' }],
    totals: ['invoices', 'qty', 'sales'],
    zeros: 'dim',
  },
};

/**
 * 3. A party statement: `union` puts invoices and payments one under the other (`set` makes a payment a credit),
 * `window` keeps a running balance per party, and output `groups` give a subtotal per party, a page holding whole
 * parties (`pageBy`).
 */
export const partyStatement: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.party.statement',
  title: 'Party Statement',
  category: 'Accounts',
  params: [...PERIOD, PARTY],
  stages: [
    {
      kind: 'source',
      id: 'billed',
      model: 'Invoice',
      fields: [
        { as: 'party', path: 'party.name' },
        { as: 'day', path: 'invoiceDate' },
        { as: 'ref', path: 'number' },
        { as: 'debit', path: 'total' },
      ],
      where: "invoiceDate between @from and @to and partyId in @party and status = 'posted'",
    },
    {
      kind: 'source',
      id: 'paid',
      model: 'Payment',
      fields: [
        { as: 'party', path: 'party.name' },
        { as: 'day', path: 'paidOn' },
        { as: 'credit', path: 'amount' },
      ],
      where: 'paidOn between @from and @to and partyId in @party',
    },
    {
      kind: 'union',
      id: 'moves',
      parts: [
        { from: 'billed', set: { credit: '0', kind: "'Invoice'" } },
        { from: 'paid', set: { ref: "'Payment'", debit: '0', kind: "'Payment'" } },
      ],
    },
    {
      kind: 'window',
      id: 'running',
      from: 'moves',
      columns: [{ as: 'balance', fn: 'runningSum', expr: 'debit - credit', partitionBy: ['party'], orderBy: [{ expr: 'day' }, { expr: 'kind' }] }],
    },
  ],
  output: {
    stage: 'running',
    columns: [
      { column: 'party', label: 'Party', repeats: 'hide' },
      { column: 'day', label: 'Date', format: 'date' },
      { column: 'ref', label: 'Ref' },
      { column: 'debit', label: 'Debit', format: 'money' },
      { column: 'credit', label: 'Credit', format: 'money' },
      { column: 'balance', label: 'Balance', format: 'money', total: 'debit - credit' },
    ],
    sort: [{ column: 'day' }],
    totals: ['debit', 'credit'],
    groups: [{ column: 'party', subtotals: ['debit', 'credit'] }],
    pageBy: 'party',
    pageSize: 20,
    negatives: 'brackets',
  },
};

/**
 * 4. Top sellers per category: `top` keeps the first N rows per partition; `window` `rank` and `share` (percent of the
 * category's total); `under(@categories)` filters by a tree (a picked category and every one under it).
 */
export const topProducts: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.product.top',
  title: 'Top Products per Category',
  category: 'Sales',
  params: [...PERIOD, { id: 'categories', label: 'Categories', type: 'lookup', multi: true, lookup: { model: 'Category', label: 'name' } }],
  stages: [
    {
      kind: 'source',
      id: 'lines',
      model: 'InvoiceLine',
      fields: [
        { as: 'category', path: 'product.category.name' },
        { as: 'product', path: 'product.name' },
        { as: 'amount', path: 'amount' },
      ],
      where: 'invoice.invoiceDate between @from and @to and product.categoryId in under(@categories)',
    },
    { kind: 'aggregate', id: 'sold', from: 'lines', groupBy: ['category', 'product'], measures: [{ as: 'sales', fn: 'sum', expr: 'amount' }] },
    {
      kind: 'window',
      id: 'ranked',
      from: 'sold',
      columns: [
        { as: 'rank', fn: 'rank', partitionBy: ['category'], orderBy: [{ expr: 'sales', dir: 'desc' }] },
        { as: 'share', fn: 'share', expr: 'sales', partitionBy: ['category'] },
      ],
    },
    { kind: 'top', id: 'best', from: 'ranked', partitionBy: ['category'], orderBy: [{ expr: 'sales', dir: 'desc' }], keep: 5 },
  ],
  output: {
    stage: 'best',
    columns: [
      { column: 'category', label: 'Category', repeats: 'dim' },
      { column: 'rank', label: '#', format: 'number', width: 50 },
      { column: 'product', label: 'Product' },
      { column: 'sales', label: 'Sales', format: 'money' },
      { column: 'share', label: 'Share %', format: 'percent' },
    ],
    sort: [{ column: 'category' }, { column: 'rank' }],
  },
};

/** 5. Month-wise sales: `pivot` turns listed values of a column into columns, with a total column. */
export const monthlySales: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.sales.monthly',
  title: 'Monthly Sales by Party',
  category: 'Sales',
  params: PERIOD,
  stages: [
    {
      kind: 'source',
      id: 'invoices',
      model: 'Invoice',
      fields: [
        { as: 'party', path: 'party.name' },
        { as: 'day', path: 'invoiceDate' },
        { as: 'total', path: 'total' },
      ],
      where: "invoiceDate between @from and @to and status = 'posted'",
    },
    { kind: 'derive', id: 'months', from: 'invoices', columns: [{ as: 'month', expr: 'month(day)' }] },
    {
      kind: 'pivot',
      id: 'grid',
      from: 'months',
      rows: ['party'],
      column: 'month',
      keys: [
        { value: 4, as: 'apr' },
        { value: 5, as: 'may' },
        { value: 6, as: 'jun' },
      ],
      measure: { fn: 'sum', expr: 'total' },
      total: 'all',
    },
  ],
  output: {
    stage: 'grid',
    columns: [
      { column: 'party', label: 'Party' },
      { column: 'apr', label: 'Apr', format: 'money', band: 'Quarter 1' },
      { column: 'may', label: 'May', format: 'money', band: 'Quarter 1' },
      { column: 'jun', label: 'Jun', format: 'money', band: 'Quarter 1' },
      { column: 'all', label: 'Total', format: 'money' },
    ],
    totals: ['apr', 'may', 'jun', 'all'],
  },
};

/**
 * 6. Stock summary: `balance` works opening, inward, outward and closing per key over a period from dated movements;
 * `join` brings in the last purchase rate (itself a `top` of one row per product).
 */
export const stockSummary: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.stock.summary',
  title: 'Stock Summary',
  category: 'Inventory',
  params: [...PERIOD, BRANCHES],
  stages: [
    {
      kind: 'source',
      id: 'moves',
      model: 'StockMove',
      fields: [
        { as: 'productId', path: 'productId' },
        { as: 'product', path: 'product.name' },
        { as: 'day', path: 'day' },
        { as: 'qtyIn', path: 'qtyIn' },
        { as: 'qtyOut', path: 'qtyOut' },
        { as: 'rate', path: 'rate' },
      ],
      where: 'day <= @to',
    },
    { kind: 'balance', id: 'stock', from: 'moves', keys: ['productId', 'product'], date: 'day', periodFrom: '@from', periodTo: '@to', inward: 'qtyIn', outward: 'qtyOut' },
    { kind: 'filter', id: 'buys', from: 'moves', where: 'qtyIn > 0' },
    { kind: 'top', id: 'lastBuy', from: 'buys', partitionBy: ['productId'], orderBy: [{ expr: 'day', dir: 'desc' }] },
    { kind: 'join', id: 'valued', from: 'stock', with: 'lastBuy', on: [{ left: 'productId', right: 'productId' }], columns: [{ as: 'rate', column: 'rate' }] },
    { kind: 'derive', id: 'out', from: 'valued', columns: [{ as: 'value', expr: 'round(closing * coalesce(rate, 0), 2)' }] },
  ],
  output: {
    stage: 'out',
    columns: [
      { column: 'product', label: 'Product' },
      { column: 'opening', label: 'Opening', format: 'qty' },
      { column: 'inward', label: 'In', format: 'qty' },
      { column: 'outward', label: 'Out', format: 'qty' },
      { column: 'closing', label: 'Closing', format: 'qty' },
      { column: 'rate', label: 'Rate', format: 'money', quiet: true },
      { column: 'value', label: 'Value', format: 'money' },
    ],
    totals: ['value'],
    zeros: 'hide',
  },
};

/**
 * 7. Stock aging: `fifo` uses each product's oldest receipts first, leaving `remaining` on the receipts still in
 * stock; `classify` sorts them into age buckets (first rule that matches); a `pivot` of the buckets.
 */
export const stockAging: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.stock.aging',
  title: 'Stock Aging',
  category: 'Inventory',
  params: [{ id: 'asOn', label: 'As on', type: 'date', default: 'today' }],
  stages: [
    {
      kind: 'source',
      id: 'moves',
      model: 'StockMove',
      fields: [
        { as: 'id', path: 'id' },
        { as: 'productId', path: 'productId' },
        { as: 'product', path: 'product.name' },
        { as: 'branchId', path: 'branchId' },
        { as: 'day', path: 'day' },
        { as: 'qtyIn', path: 'qtyIn' },
        { as: 'qtyOut', path: 'qtyOut' },
      ],
      where: 'day <= @asOn',
    },
    { kind: 'fifo', id: 'layers', from: 'moves', keys: ['productId', 'branchId'], order: [{ expr: 'day' }, { expr: 'id' }], inward: 'qtyIn', outward: 'qtyOut' },
    { kind: 'filter', id: 'open', from: 'layers', where: 'remaining > 0' },
    { kind: 'derive', id: 'aged', from: 'open', columns: [{ as: 'age', expr: 'daysBetween(day, @asOn)' }] },
    {
      kind: 'classify',
      id: 'bucketed',
      from: 'aged',
      as: 'bucket',
      rules: [
        { when: 'age <= 30', value: 'b30' },
        { when: 'age <= 90', value: 'b90' },
      ],
      otherwise: 'older',
    },
    {
      kind: 'pivot',
      id: 'grid',
      from: 'bucketed',
      rows: ['product'],
      column: 'bucket',
      keys: [
        { value: 'b30', as: 'upTo30' },
        { value: 'b90', as: 'upTo90' },
        { value: 'older', as: 'older' },
      ],
      measure: { fn: 'sum', expr: 'remaining' },
      total: 'inStock',
    },
  ],
  output: {
    stage: 'grid',
    columns: [
      { column: 'product', label: 'Product' },
      { column: 'upTo30', label: '0–30 days', format: 'qty' },
      { column: 'upTo90', label: '31–90 days', format: 'qty' },
      { column: 'older', label: 'Older', format: 'qty', tone: 'warning' },
      { column: 'inStock', label: 'In stock', format: 'qty' },
    ],
    totals: ['upTo30', 'upTo90', 'older', 'inStock'],
  },
};

/**
 * 8. This year against last year: `periods` gives each row the name of every period its date is in; the source reads
 * the whole span with `@<stage>_from` / `@<stage>_to`; columns are banded by period heading (`band`).
 */
export const yearOnYear: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.sales.year-on-year',
  title: 'Sales, This Year and Last',
  category: 'Sales',
  params: PERIOD,
  stages: [
    {
      kind: 'source',
      id: 'invoices',
      model: 'Invoice',
      fields: [
        { as: 'party', path: 'party.name' },
        { as: 'day', path: 'invoiceDate' },
        { as: 'total', path: 'total' },
      ],
      where: "invoiceDate between @span_from and @span_to and status = 'posted'",
    },
    {
      kind: 'periods',
      id: 'span',
      from: 'invoices',
      date: 'day',
      periodFrom: '@from',
      periodTo: '@to',
      periods: [
        { name: 'now', label: 'FY {fy}' },
        { name: 'last', label: 'FY {fy}', shiftYears: -1 },
      ],
    },
    {
      kind: 'aggregate',
      id: 'out',
      from: 'span',
      groupBy: ['party'],
      measures: [
        { as: 'now', fn: 'sum', expr: 'total', where: "period = 'now'" },
        { as: 'last', fn: 'sum', expr: 'total', where: "period = 'last'" },
      ],
    },
  ],
  output: {
    stage: 'out',
    columns: [
      { column: 'party', label: 'Party' },
      { column: 'now', label: 'Sales', format: 'money', band: 'now' },
      { column: 'last', label: 'Sales', format: 'money', band: 'last' },
    ],
    totals: ['now', 'last'],
  },
};

/**
 * 9. Parties with nothing billed: `exists` with `negate` keeps rows with no match in another stage. Party is a master
 * every branch shares (`rowScope.free`), so `branchScope: 'none'` is not needed here.
 */
export const idleParties: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.party.idle',
  title: 'Parties Not Billed',
  category: 'Sales',
  params: PERIOD,
  stages: [
    {
      kind: 'source',
      id: 'parties',
      model: 'Party',
      fields: [
        { as: 'id', path: 'id' },
        { as: 'name', path: 'name' },
        { as: 'city', path: 'city' },
      ],
      where: 'isActive',
    },
    { kind: 'source', id: 'billed', model: 'Invoice', fields: [{ as: 'partyId', path: 'partyId' }], where: 'invoiceDate between @from and @to' },
    { kind: 'exists', id: 'idle', from: 'parties', in: 'billed', on: [{ left: 'id', right: 'partyId' }], negate: true },
  ],
  output: {
    stage: 'idle',
    columns: [
      { column: 'name', label: 'Party' },
      { column: 'city', label: 'City' },
    ],
    sort: [{ column: 'name' }],
  },
};

/**
 * 10. Receivables by due date: the open invoices with a colour per row (`toneBy`), footers under the totals (the
 * overdue part), and a drill into the party statement with the row's party.
 */
export const receivables: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.party.receivables',
  title: 'Receivables',
  category: 'Accounts',
  params: [{ id: 'asOn', label: 'As on', type: 'date', default: 'today' }],
  stages: [
    {
      kind: 'source',
      id: 'open',
      model: 'Invoice',
      fields: [
        { as: 'partyId', path: 'partyId' },
        { as: 'party', path: 'party.name' },
        { as: 'number', path: 'number' },
        { as: 'due', path: 'dueDate' },
        { as: 'amount', path: 'total' },
      ],
      where: "status = 'posted' and invoiceDate <= @asOn",
    },
    {
      kind: 'derive',
      id: 'out',
      from: 'open',
      columns: [
        { as: 'late', expr: 'greatest(daysBetween(coalesce(due, @asOn), @asOn), 0)' },
        { as: 'tone', expr: "if(due < @asOn, 'danger', 'success')" },
      ],
    },
  ],
  output: {
    stage: 'out',
    columns: [
      { column: 'party', label: 'Party', drill: { report: 'sample.party.statement', params: { party: 'partyId' } } },
      { column: 'number', label: 'Invoice' },
      { column: 'due', label: 'Due', format: 'date' },
      { column: 'late', label: 'Days late', format: 'number', toneBy: 'tone' },
      { column: 'amount', label: 'Amount', format: 'money' },
    ],
    totals: ['amount'],
    footers: [{ label: 'Overdue', where: 'late > 0' }],
  },
};

/**
 * 11. A figure the project's code works out: an `engine` stage (shipped reports only) asks a named engine
 * (`defineReportEngine`) for figures by key; here the sample engine `sampleCreditUsed` (registered by the spec).
 */
export const creditUse: Rdl2Report = {
  lang: 'rdl2',
  name: 'sample.party.credit',
  title: 'Credit Used',
  category: 'Accounts',
  params: [],
  stages: [
    {
      kind: 'source',
      id: 'parties',
      model: 'Party',
      fields: [
        { as: 'id', path: 'id' },
        { as: 'name', path: 'name' },
        { as: 'limit', path: 'creditLimit' },
      ],
    },
    { kind: 'engine', id: 'used', from: 'parties', name: 'sampleCreditUsed', keys: ['id'] },
    { kind: 'derive', id: 'out', from: 'used', columns: [{ as: 'free', expr: 'limit - coalesce(creditUsed, 0)' }] },
  ],
  output: {
    stage: 'out',
    columns: [
      { column: 'name', label: 'Party' },
      { column: 'limit', label: 'Limit', format: 'money' },
      { column: 'creditUsed', label: 'Used', format: 'money' },
      { column: 'free', label: 'Free', format: 'money' },
    ],
  },
};

/**
 * 12. A project's own stage kind (`defineReportStage`): `margin` (registered by the spec) adds a cost and a margin per
 * line from code, joined back so the stages after it go on in SQL. `SampleMarginStage` types it.
 */
export interface SampleMarginStage extends Rdl2StageBase {
  kind: 'margin';
  from: string;
  /** Column holding the product id. */
  product: string;
  /** Expression for the line's value. */
  amount: string;
}

export const lineMargin: Rdl2Report<SampleMarginStage> = {
  lang: 'rdl2',
  name: 'sample.line.margin',
  title: 'Margin by Product',
  category: 'Sales',
  params: PERIOD,
  stages: [
    {
      kind: 'source',
      id: 'lines',
      model: 'InvoiceLine',
      fields: [
        { as: 'productId', path: 'productId' },
        { as: 'product', path: 'product.name' },
        { as: 'qty', path: 'qty' },
        { as: 'amount', path: 'amount' },
      ],
      where: 'invoice.invoiceDate between @from and @to',
    },
    { kind: 'margin', id: 'costed', from: 'lines', product: 'productId', amount: 'amount' },
    {
      kind: 'aggregate',
      id: 'out',
      from: 'costed',
      groupBy: ['product'],
      measures: [
        { as: 'sales', fn: 'sum', expr: 'amount' },
        { as: 'margin', fn: 'sum', expr: 'margin' },
      ],
    },
  ],
  output: {
    stage: 'out',
    columns: [
      { column: 'product', label: 'Product' },
      { column: 'sales', label: 'Sales', format: 'money' },
      { column: 'margin', label: 'Margin', format: 'money' },
    ],
    totals: ['sales', 'margin'],
  },
};

/** Every sample, for the spec and as a project's `shipped` list while trying the studio out. */
export const SAMPLE_REPORTS: ReadonlyArray<Rdl2Report<Rdl2StageBase>> = [
  invoiceRegister,
  partySummary,
  partyStatement,
  topProducts,
  monthlySales,
  stockSummary,
  stockAging,
  yearOnYear,
  idleParties,
  receivables,
  creditUse,
  lineMargin,
];
