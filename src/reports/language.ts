/**
 * The report language (RDL2), as JSON: parameters, a list of stages and an output. Stages build on earlier stages,
 * like steps in a pipeline. There is no SQL anywhere in a definition: models, fields and relations are catalog names
 * (`catalog.ts`), and every condition or computed value is an expression (`../expr`, compiled by `expr/sql.ts`). The
 * runner adds the company (partition), row-scope and soft-delete conditions itself. Guide: `docs/reports.md`.
 *
 * A project adds stage kinds of its own (`defineReportStage`): `Rdl2Report<MyStage>` types its reports with them.
 */

export const RDL2 = 'rdl2' as const;

export type Rdl2ParamType = 'date' | 'number' | 'text' | 'boolean' | 'select' | 'lookup';

/** A report input. The viewer turns these into its filter panel. */
export interface Rdl2Param {
  /** Referred to as `@id` in expressions. */
  id: string;
  label: string;
  type: Rdl2ParamType;
  required?: boolean;
  /** Literal default, or a date word: `fyStart`, `fyEnd`, `today`, `monthStart`. */
  default?: unknown;
  /** `lookup`: pick one or several rows; the value is the ids. */
  multi?: boolean;
  /** `select`: fixed choices. */
  options?: { value: string | number | boolean; label: string }[];
  /**
   * `lookup`: where the choices come from (catalog model; label and value fields). `preset` names
   * one of the app's own lookups (`party`, `product`, `salesman`…), which the viewer shows instead
   * of a plain list of `label`; `model` and `label` stay set, so a viewer that does not know the
   * preset still lists the same records. The run gets the picked ids either way.
   */
  lookup?: { model: string; label: string; value?: string; where?: string; preset?: string };
  /**
   * Narrows the row scope (`reports.rowScope`, such as the branches a user may read): a `lookup` whose ids replace
   * the allowed ones, never widening them. The name is kept from the first project that used it (branches).
   */
  branchScope?: boolean;
}

/** One output column of a source stage: a field of the model, or through belongs-to relations. */
export interface Rdl2SourceField {
  /** Column name in this stage. */
  as: string;
  /** `invoiceDate`, `party.name`, `party.city.state.name`. */
  path: string;
}

export interface Rdl2SourceStage {
  kind: 'source';
  id: string;
  model: string;
  fields: Rdl2SourceField[];
  /** Expression over the model's fields and relation paths: `status = 'active' and party.isActive`. */
  where?: string;
  /**
   * How the row scope reaches this model. `auto` (default): its own scope field, else the catalog's scope path
   * (`reports.rowScope`). `none`: not scoped (masters every scope shares).
   */
  branchScope?: 'auto' | 'none';
}

/**
 * Rows of several stages one under the other. Each part may `set` columns by expression, such as
 * `{ amount: '-amount', kind: "'CN'" }`, so a credit note subtracts. Parts must end with the same
 * columns; the first part's order is used.
 */
export interface Rdl2UnionStage {
  kind: 'union';
  id: string;
  parts: { from: string; set?: Record<string, string> }[];
  /** Keep only these columns of the first part's list. Omitted keeps all. */
  keep?: string[];
}

export interface Rdl2FilterStage {
  kind: 'filter';
  id: string;
  from: string;
  where: string;
}

/** Add or replace columns computed from the row. */
export interface Rdl2DeriveStage {
  kind: 'derive';
  id: string;
  from: string;
  columns: { as: string; expr: string }[];
  /** Keep only these columns (after deriving). Omitted keeps all. */
  keep?: string[];
}

export type Rdl2AggregateFn = 'sum' | 'count' | 'min' | 'max' | 'avg' | 'countDistinct' | 'list' | 'first' | 'last';

export interface Rdl2Measure {
  as: string;
  fn: Rdl2AggregateFn;
  /** Value to aggregate. `count` may omit it. */
  expr?: string;
  /** Only rows meeting this count: `sum(amount) where type = 'SI'`. */
  where?: string;
  /** `list`: the separator. `first`/`last`: the order expression. */
  separator?: string;
  orderBy?: string;
}

export interface Rdl2AggregateStage {
  kind: 'aggregate';
  id: string;
  from: string;
  groupBy: string[];
  measures: Rdl2Measure[];
  /** Condition on the grouped rows, over group columns and measures. */
  having?: string;
}

/**
 * `share`: percent of the partition's total (100 × value ÷ sum). `list`: the partition's values
 * joined with ", " (empty values skipped), such as the other accounts of a voucher on each line.
 */
export type Rdl2WindowFn = 'runningSum' | 'rowNumber' | 'rank' | 'denseRank' | 'previous' | 'next' | 'partitionSum' | 'partitionCount' | 'share' | 'list';

export interface Rdl2WindowStage {
  kind: 'window';
  id: string;
  from: string;
  columns: {
    as: string;
    fn: Rdl2WindowFn;
    expr?: string;
    partitionBy?: string[];
    orderBy?: { expr: string; dir?: 'asc' | 'desc' }[];
  }[];
}

export interface Rdl2JoinStage {
  kind: 'join';
  id: string;
  from: string;
  with: string;
  type?: 'left' | 'inner';
  on: { left: string; right: string }[];
  /** Columns taken from `with`. The `from` columns all stay. */
  columns: { as: string; column: string }[];
}

/** Keep rows that have (or, with `negate`, have no) matching row in another stage. */
export interface Rdl2ExistsStage {
  kind: 'exists';
  id: string;
  from: string;
  in: string;
  on: { left: string; right: string }[];
  where?: string;
  negate?: boolean;
}

/** The first `keep` rows of each partition by an order, such as the latest price per product. */
export interface Rdl2TopStage {
  kind: 'top';
  id: string;
  from: string;
  partitionBy: string[];
  orderBy: { expr: string; dir?: 'asc' | 'desc' }[];
  keep?: number;
}

/** Values of one column become columns: months, voucher types. Keys are listed, not discovered. */
export interface Rdl2PivotStage {
  kind: 'pivot';
  id: string;
  from: string;
  rows: string[];
  column: string;
  keys: { value: string | number; as: string }[];
  measure: { fn: Rdl2AggregateFn; expr?: string };
  /** Add a column with the sum across keys. */
  total?: string;
}

/**
 * Opening, inward, outward and closing per key over a period, from dated movements: stock
 * quantities, ledger amounts. Opening counts movements before `from`; in and out those in the period.
 */
export interface Rdl2BalanceStage {
  kind: 'balance';
  id: string;
  from: string;
  keys: string[];
  date: string;
  /** Period start and end expressions, usually `@from` and `@to`. */
  periodFrom: string;
  periodTo: string;
  inward: string;
  outward: string;
  /** Keep rows with all four zero. Default false. */
  keepZero?: boolean;
}

/** Sort rows into named buckets by rules, first match wins: GST sections, aging buckets. */
export interface Rdl2ClassifyStage {
  kind: 'classify';
  id: string;
  from: string;
  as: string;
  rules: { when: string; value: string }[];
  otherwise?: string;
}

/**
 * First in, first out: outward rows of a key use up its oldest inward rows first. Every row gets
 * `as` (default `remaining`): what is still open of that row's inward, 0 on outward rows. Stock
 * aging (open quantity per receipt date), bill-wise outstanding (open amount per invoice).
 * Outward is taken from the whole key, so an outward dated before an inward still uses it up.
 */
export interface Rdl2FifoStage {
  kind: 'fifo';
  id: string;
  from: string;
  /** One FIFO queue per key: product, variant and branch. */
  keys: string[];
  /** Oldest first: date, then a tie-breaker such as the row id. */
  order: { expr: string; dir?: 'asc' | 'desc' }[];
  inward: string;
  outward: string;
  as?: string;
}

/**
 * Periods to compare: the base period (usually `@from` to `@to`) and periods worked out from it,
 * such as the same span last year, last month, the previous span of the same length, or the same
 * month in each of the last few years. Each row gets the name of every period its date is in (a
 * row in two overlapping periods appears twice), so later stages sum per period. Earlier stages read
 * the whole span with `@<stage id>_from` and `@<stage id>_to`. The periods' dates and headings come
 * back in the result (`meta.periods`), for column bands.
 */
export interface Rdl2PeriodsStage {
  kind: 'periods';
  id: string;
  from: string;
  /** Column holding the row's date. */
  date: string;
  /** The base period: a date input such as `@from`, or a date. */
  periodFrom: string;
  periodTo: string;
  /** Column that gets the period name. Default `period`. */
  as?: string;
  /**
   * The periods, in order. One without a shift is the base itself. `shiftYears` / `shiftMonths`
   * move the base (a base ending on a month's last day keeps ending on one); `previous` is the span
   * of the same length just before (whole months stay whole months). `repeat` makes a series:
   * `y` with `shiftYears: -1, repeat: 3` is y1, y2, y3, one more year back each time.
   * `label` is the heading: `{from}`, `{to}`, `{fromMonth}`, `{toMonth}`, `{fy}`, `{year}` are filled in.
   */
  periods: { name: string; label?: string; shiftYears?: number; shiftMonths?: number; previous?: boolean; repeat?: number }[];
}

/**
 * Figures a project engine works out in code for the stage's rows, by their keys (`defineReportEngine`): a bill's due
 * as on a day, an item's stock value. Shipped reports only. The runner reads the keys the stage receives, asks the
 * engine and compiles again with the figures joined back; later stages run in SQL.
 */
export interface Rdl2EngineStage {
  kind: 'engine';
  id: string;
  from: string;
  /** The engine's name (`defineReportEngine`). */
  name: string;
  /** The columns naming each row's thing (a bill's id; an item and branch), in the engine's order. */
  keys: string[];
  /** The engine's inputs: report inputs (`@asOn`) or values. */
  args?: Record<string, string>;
}

/**
 * A TypeScript stage registered in code (`defineNativeStage`), the last stage: it shapes the rows in memory. Only
 * reports shipped in code may use one; a definition sent by a user that names one is refused.
 */
export interface Rdl2NativeStage {
  kind: 'native';
  id: string;
  name: string;
  from?: string;
  args?: Record<string, unknown>;
}

/** What every stage has: a project's own stage kinds (`defineReportStage`) extend it. */
export interface Rdl2StageBase {
  kind: string;
  id: string;
  from?: string;
}

/** The stage kinds the framework compiles. */
export type Rdl2Stage =
  | Rdl2SourceStage
  | Rdl2UnionStage
  | Rdl2FilterStage
  | Rdl2DeriveStage
  | Rdl2AggregateStage
  | Rdl2WindowStage
  | Rdl2JoinStage
  | Rdl2ExistsStage
  | Rdl2TopStage
  | Rdl2PivotStage
  | Rdl2BalanceStage
  | Rdl2ClassifyStage
  | Rdl2FifoStage
  | Rdl2EngineStage
  | Rdl2PeriodsStage
  | Rdl2NativeStage;

export type Rdl2ColumnFormat = 'text' | 'number' | 'money' | 'qty' | 'date' | 'datetime' | 'boolean' | 'percent';

/** Colour of a total or a summary card: green, blue, yellow, orange, red. */
export type Rdl2Tone = 'success' | 'info' | 'warning' | 'alert' | 'danger';

/** A figure above the grid: the whole result's sum of one column. */
export interface Rdl2Card {
  column: string;
  label: string;
  tone?: Rdl2Tone;
  /** Cards with the same line sit in one row, lowest line first. Default 1. */
  line?: number;
}

export interface Rdl2OutputColumn {
  /** Column of the output stage. */
  column: string;
  label: string;
  format?: Rdl2ColumnFormat;
  align?: 'left' | 'right' | 'center';
  width?: number;
  /** Secondary: drawn dimmer. */
  quiet?: boolean;
  /** Off the grid until the user shows it from the column picker. */
  hidden?: boolean;
  /** A value equal to the row above: `hide` leaves it blank, `dim` draws it quiet. Chains left to right. */
  repeats?: 'hide' | 'dim';
  /** Another column of the row, drawn as a quiet second line under the value (variant under product). */
  caption?: string;
  /** Colour of this column's total. */
  tone?: Rdl2Tone;
  /** Can be filtered from the grid's filter row. Default true. */
  filterable?: boolean;
  /**
   * The total of this column as a formula over the other columns' totals, such as
   * `gp / sales * 100` for GP %: a percentage or a rate is worked out from the sums, never summed.
   * Used in the totals line, group subtotals and footer lines.
   */
  total?: string;
  /**
   * Heading over a run of neighbouring columns with the same band. The name of a period of a
   * `periods` stage shows that period's heading ("FY-2026-27 Upto Aug-26"); other text shows as is.
   */
  band?: string;
  /** Another column of the row holding this cell's colour: `success`, `info`, `warning`, `alert` or `danger`. */
  toneBy?: string;
  /** Opens a record's page (`voucher`: a type and an id, the viewer's drill links) or another report. Values come from the row. */
  drill?: { voucher?: { type: string; id: string } } | { report: string; params: Record<string, string> };
}

export interface Rdl2Output {
  stage: string;
  columns: Rdl2OutputColumn[];
  /** Default order. The viewer may sort by any output column. */
  sort?: { column: string; dir?: 'asc' | 'desc' }[];
  /** Columns summed over the whole result for the totals line. */
  totals?: string[];
  /** Row groups with a subtotal line per group, outermost first. */
  groups?: { column: string; subtotals?: string[] }[];
  /** Rows per page. Default 100. `0` returns every row (capped by the runner). */
  pageSize?: number;
  /**
   * One of the `groups` columns: a page then holds whole groups, never part of one, and the page
   * size counts groups (10 parties with all their bills). Without it a page holds that many rows.
   */
  pageBy?: string;
  /** Figures above the grid. The runner sums their columns over the whole result. */
  cards?: Rdl2Card[];
  /** Zeros in number columns: `dim` draws them faint, `hide` leaves the cell empty. Default shown. */
  zeros?: 'dim' | 'hide';
  /** Negative numbers drawn as `(1,234)` instead of `-1,234`. */
  negatives?: 'brackets';
  /**
   * Lines under the totals, each the totals of the rows its condition keeps, such as all but one
   * product type, or the new product types (`productTypeId in @newTypes`). Formulas (`total`) apply.
   * `needs` names an input: the line shows only when that input has a value.
   */
  footers?: { label: string; where?: string; needs?: string }[];
  /**
   * Work out only the columns a viewer shows: the grid's visible columns, the fields a pivot uses.
   * Quick when few are shown, but showing another column or adding a pivot field runs the report
   * again. Off (default): every column comes at once, then the grid and the pivot need no more
   * runs. On suits a small report; a costly one is better off loading once.
   */
  columnsOnDemand?: boolean;
}

/**
 * Where the report shows in the viewer's report menu. Without `show` it is only in the studio list.
 * `group` puts it in a submenu; a path such as `Sales / Monthly` nests deeper. Lower `order` comes first.
 * Every `/` in `group` starts a deeper submenu, so a name that needs one is written with `-` (`Sales CN-DN`).
 */
export interface Rdl2Menu {
  show?: boolean;
  group?: string;
  order?: number;
  /** Menu text when it differs from the title. */
  label?: string;
}

export interface Rdl2Report<Extra extends Rdl2StageBase = never> {
  lang: typeof RDL2;
  /** Stable name: `sales.register.summary`. Code reports are found by it. */
  name: string;
  title: string;
  description?: string;
  category?: string;
  params: Rdl2Param[];
  stages: Array<Rdl2Stage | Extra>;
  output: Rdl2Output;
  /** Frontend layout (grid layout JSON). The runner does not read it. */
  layout?: unknown;
  /** Desk menu placement. The runner does not read it. */
  menu?: Rdl2Menu;
}

/**
 * A saved pivot over a report: which report, the inputs it starts with and the pivot layout. It
 * has no steps of its own; the pivot runs its source with the columns its layout uses.
 */
export interface Rdl2PivotView {
  lang: typeof RDL2;
  kind: 'pivot';
  name: string;
  title: string;
  description?: string;
  category?: string;
  /** The report whose rows it pivots, by name (shipped or saved). */
  source: string;
  /** Keep its rows on the user's computer: it opens with them, and Reload fetches fresh ones. */
  cache?: boolean;
  /** Input values as a saved filter keeps them (a period by its name, so it moves with the year). */
  filter?: Record<string, unknown>;
  /** The pivot layout (rows, columns, filters, values). The runner does not read it. */
  layout: unknown;
  menu?: Rdl2Menu;
}

/** What the viewer sends to run a report. */
export interface Rdl2RunRequest {
  /** A report shipped in code or a saved report's name. */
  name?: string;
  /** A saved report's id. */
  id?: number;
  /** A definition to run as is (designer preview). */
  definition?: Rdl2Report<Rdl2StageBase>;
  params?: Record<string, unknown>;
  /** Grid filter-row conditions on output columns: `{ $and: [{ column: { $op: value } }] }`. */
  where?: Record<string, unknown>;
  sort?: { column: string; dir?: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
  /** Stop after this stage and return its rows, for the designer's per-stage preview. */
  previewStage?: string;
  /**
   * Output columns the viewer shows (a grid's visible columns, the fields a pivot uses). Only these,
   * and what they and the output's sort, groups, cards and footers need, are worked out: a source
   * reads no relation, and a computed stage (`cost`, `engine`) works out nothing, for a column nobody asked for. Omitted: every
   * output column.
   */
  columns?: string[];
  /**
   * Rows only, for a pivot that sums them itself: no totals, cards, footers or group subtotals, and
   * no default sort, so none of their columns is worked out unless `columns` asks for it.
   */
  bare?: boolean;
  /**
   * Rows grouped on the server, for a pivot: one row per distinct `keys`, so the browser only adds
   * groups up. Implies `bare`; the columns worked out are the keys and values.
   */
  summary?: Rdl2RunSummary;
}

/**
 * A grouped run. Each row has the keys, `__rows` (rows in the group) and, per value column,
 * `<column>__n` (rows with a value), and for number columns `<column>` (the sum), `<column>__min`
 * and `<column>__max`. Every pivot figure follows from these: an average is sum ÷ count, a distinct
 * count groups by its column. Rows come ordered by the keys, so `limit` / `offset` pages are stable.
 */
export interface Rdl2RunSummary {
  /** Output columns to group by. A date column may group by its month, quarter, financial year (from April) or year. */
  keys: { column: string; bucket?: Rdl2DateBucket }[];
  /** Output columns to total. */
  values: string[];
}

export type Rdl2DateBucket = 'month' | 'quarter' | 'fy' | 'year';

export interface Rdl2RunResult {
  columns: { name: string; label: string; format?: Rdl2ColumnFormat }[];
  rows: Record<string, unknown>[];
  /** Rows in the whole result. */
  count: number;
  /** Groups in the whole result, when the report pages by group (`output.pageBy`). Pages count these. */
  groups?: number;
  totals: Record<string, unknown> | null;
  /** `truncated`: the page stopped at the runner's row cap, so some rows of it are missing. */
  meta: {
    ms: number;
    report: string;
    stage?: string;
    sql?: string;
    truncated?: boolean;
    /** Periods of `periods` stages, with their dates and headings, for column bands. */
    periods?: { stage: string; name: string; label: string; from: string; to: string }[];
  };
}
