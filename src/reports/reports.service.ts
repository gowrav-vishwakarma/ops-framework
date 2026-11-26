import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { SQL_FUNCTIONS } from '../expr/sql.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { ReportCatalogService } from './catalog.js';
import { RDL2, type Rdl2Menu, type Rdl2PivotView, type Rdl2Report, type Rdl2RunRequest, type Rdl2StageBase } from './language.js';
import type { ReportsConfig, ReportStore, ReportUser, ReportUserSource, StoredReport } from './options.js';
import { ReportRunner } from './runner.js';
import { REPORT_STORE, REPORT_USER_SOURCE, REPORTS_CONFIG } from './tokens.js';

type Report = Rdl2Report<Rdl2StageBase>;

export interface LookupRequest {
  model: string;
  label: string;
  value?: string;
  query?: string;
  limit?: number;
}

export interface SaveRequest {
  id?: number;
  definition: Report | Rdl2PivotView;
  status?: 'draft' | 'published';
}

/** A saved pivot's layout and filter are kept as given; this caps their size. */
const MAX_PIVOT_JSON = 100_000;
/** Saved pivots over one report that its delete removes with it. */
const PIVOT_CAP = 100;

/**
 * The report studio: the catalog, the list, a run, a lookup, save and delete. Saved reports live in the project's
 * store (`ReportStore`); the rules for what may be saved and deleted are here, the same for every project.
 */
@Injectable()
export class ReportService {
  constructor(
    private readonly catalogs: ReportCatalogService,
    private readonly runner: ReportRunner,
    private readonly db: TenantDb,
    @Inject(REPORT_STORE) private readonly store: ReportStore,
    @Inject(REPORT_USER_SOURCE) private readonly users: ReportUserSource,
    @Inject(REPORTS_CONFIG) private readonly config: ReportsConfig,
  ) {}

  /** The signed-in user, as the project reads them from the request. */
  user(): ReportUser {
    return this.users.current();
  }

  /** Every model a report may read, with fields, relations and scope; and the expression functions. */
  catalog() {
    return { ...this.catalogs.publicCatalog(), functions: SQL_FUNCTIONS };
  }

  /** Shipped reports first, then the company's saved ones. Saved pivots (layouts over a report) come apart. */
  async list(user: ReportUser) {
    const shipped = (this.config.shipped?.() ?? []).map((report) => ({
      origin: 'system',
      name: report.name,
      title: report.title,
      category: report.category ?? 'Other',
      description: report.description ?? '',
      definition: report,
    }));
    const rows = (await this.store.list(user)).filter((row) => row.definition?.lang === RDL2 && row.status !== 'archived');
    rows.sort((a, b) => (a.title ?? a.definition.title ?? '').localeCompare(b.title ?? b.definition.title ?? ''));
    const isPivot = (row: StoredReport) => (row.definition as { kind?: unknown }).kind === 'pivot';
    const described = (row: StoredReport) => ({
      id: row.id,
      name: row.definition.name,
      title: row.definition.title || row.title || '',
      category: row.definition.category ?? row.category ?? 'Other',
      description: row.definition.description ?? row.description ?? '',
      definition: row.definition,
    });
    const pivots = rows.filter(isPivot).map(described);
    const saved = rows.filter((row) => !isPivot(row)).map((row) => ({ origin: 'saved', ...described(row), status: row.status }));
    return { reports: [...shipped, ...saved], pivots };
  }

  /**
   * `{ name }` (shipped or saved), `{ id }` (saved) or `{ definition }` (preview), with `params`, grid `where`, `sort`,
   * `limit` and `offset`. Always scoped to the user's company and row scope.
   */
  run(request: Rdl2RunRequest, user: ReportUser) {
    return this.runner.run(request ?? {}, user);
  }

  /** Choices for a lookup parameter: `{ model, label, value?, query }` → `{ rows: [{ value, label }] }`. */
  lookup(request: LookupRequest, user: ReportUser) {
    if (!request?.model || !request.label) throw new BadRequestException('A lookup names a model and its label field');
    return this.runner.lookup(request, user);
  }

  /**
   * Save a report for the company. It is compiled first (a run of one row), so a saved report always runs. Native and
   * shipped-only stages are refused: only reports shipped in code may use them.
   *
   * A saved pivot (`kind: 'pivot'`) is a layout over another report: its source must be a report the company can run
   * (not another pivot), and it is listed apart from reports.
   */
  async save(request: SaveRequest, user: ReportUser) {
    const given = request?.definition as { kind?: unknown } | undefined;
    const definition = given?.kind === 'pivot' ? await this.checkPivot(given as Rdl2PivotView, user) : this.runner.check(given);
    if (typeof definition.name !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,80}$/.test(definition.name)) {
      throw new BadRequestException('Name a report with lower-case letters, digits, dots and dashes, such as sales.party.summary');
    }
    if (typeof definition.title !== 'string' || !definition.title.trim()) throw new BadRequestException('Give the report a title');
    if (this.runner.shipped(definition.name)) throw new BadRequestException(`"${definition.name}" is a system report name; choose another`);
    const menu = cleanMenu(definition.menu);
    if (menu) definition.menu = menu;
    else delete definition.menu;
    if (!('kind' in definition)) {
      if (definition.stages.some((stage) => stage.kind === 'native')) throw new BadRequestException('Saved reports cannot use native stages');
      // Compiles and checks every name; throws with the stage that is wrong.
      await this.runner.run({ definition, limit: 1 }, user, undefined, { compute: false });
    }

    return this.db.tx(async (t) => {
      const same = await this.store.byName(user, definition.name, t);
      const write = { definition, status: request.status ?? 'published' };
      if (request.id) {
        const row = await this.ownRow(request.id, user, t);
        if (same && same.id !== row.id) throw new BadRequestException(`Another report is already named "${definition.name}"`);
        await this.store.update(user, row.id, write, t);
        return { id: row.id, name: definition.name };
      }
      if (same) throw new BadRequestException(`A report named "${definition.name}" already exists`);
      const { id } = await this.store.create(user, write, t);
      return { id, name: definition.name };
    });
  }

  /**
   * Delete a company report; its saved pivots go with it. System reports are not stored and cannot be removed. Answers
   * `{ done: true }`.
   */
  async delete(request: { id?: number }, user: ReportUser) {
    const id = request?.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new BadRequestException('Name the report to delete');
    const keep = `System reports stay with ${this.config.product ?? 'the system'}`;
    return this.db.tx(async (t) => {
      const row = await this.ownRow(id, user, t);
      if (row.system) throw new BadRequestException(keep);
      const definition = row.definition as { kind?: unknown; name?: unknown };
      const name = typeof definition?.name === 'string' ? definition.name : '';
      if (!name) throw new BadRequestException('This report has no name');
      if (this.runner.shipped(name)) throw new BadRequestException(keep);

      const ids = [row.id];
      if (definition.kind !== 'pivot') {
        const pivots = await this.store.pivotsOf(user, name, PIVOT_CAP + 1, t);
        if (pivots.length > PIVOT_CAP) throw new BadRequestException(`Too many saved pivots use this report (more than ${PIVOT_CAP}). Delete some pivots first.`);
        ids.push(...pivots);
      }
      await this.store.remove(user, ids, t);
      return { done: true };
    });
  }

  /** A saved report of this company. Another company's is not found (the store reads the user's company only). */
  private async ownRow(id: number, user: ReportUser, t: Transaction): Promise<StoredReport> {
    const row = await this.store.get(user, id, t);
    if (!row) throw new NotFoundException('Report not found');
    return row;
  }

  /** A saved pivot as stored: its own fields only, over a report the company can run. */
  private async checkPivot(given: Rdl2PivotView, user: ReportUser): Promise<Rdl2PivotView> {
    if (typeof given.source !== 'string' || !given.source) throw new BadRequestException('A saved pivot names the report it pivots');
    // Resolves shipped and saved reports; a saved pivot is refused as a source.
    await this.runner.resolve({ name: given.source }, user);
    if (!given.layout || typeof given.layout !== 'object') throw new BadRequestException('A saved pivot needs its layout');
    const filter = given.filter && typeof given.filter === 'object' && !Array.isArray(given.filter) ? given.filter : {};
    if (JSON.stringify([given.layout, filter]).length > MAX_PIVOT_JSON) throw new BadRequestException('This pivot layout is too large to save');
    return {
      lang: RDL2,
      kind: 'pivot',
      name: given.name,
      title: typeof given.title === 'string' ? given.title.trim().slice(0, 100) : '',
      ...(typeof given.description === 'string' && given.description.trim() ? { description: given.description.trim().slice(0, 500) } : {}),
      ...(typeof given.category === 'string' && given.category.trim() ? { category: given.category.trim().slice(0, 50) } : {}),
      source: given.source,
      ...(given.cache === true ? { cache: true } : {}),
      filter,
      layout: given.layout,
      ...(given.menu ? { menu: given.menu } : {}),
    };
  }
}

/** Menu placement: plain values only, group path trimmed to a few short levels. */
function cleanMenu(menu: unknown): Rdl2Menu | undefined {
  if (!menu || typeof menu !== 'object') return undefined;
  const given = menu as Rdl2Menu;
  const group =
    typeof given.group === 'string'
      ? given.group
          .split('/')
          .map((part) => part.trim().slice(0, 40))
          .filter(Boolean)
          .slice(0, 3)
          .join(' / ')
      : '';
  return {
    show: given.show === true,
    ...(group ? { group } : {}),
    ...(typeof given.order === 'number' && Number.isFinite(given.order) ? { order: given.order } : {}),
    ...(typeof given.label === 'string' && given.label.trim() ? { label: given.label.trim().slice(0, 80) } : {}),
  };
}
