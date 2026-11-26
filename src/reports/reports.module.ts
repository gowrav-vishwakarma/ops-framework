import { Body, Controller, HttpCode, Module, Post, type DynamicModule, type Type } from '@nestjs/common';
import { RequirePermission } from '../auth/decorators.js';
import { Slot } from '../request/slot.js';
import { ReportCatalogService } from './catalog.js';
import type { Rdl2RunRequest } from './language.js';
import type { ReportAction, ReportsConfig } from './options.js';
import { ReportService, type LookupRequest, type SaveRequest } from './reports.service.js';
import { ReportRunner } from './runner.js';
import { REPORT_ROW_SCOPE, REPORT_STORE, REPORT_USER_SOURCE, REPORTS_CONFIG } from './tokens.js';

/** Route names when the project gives none. */
const ACTIONS: Record<ReportAction, string> = { catalog: 'catalog', list: 'list', run: 'run', lookup: 'lookup', save: 'save', delete: 'delete' };

/**
 * The studio's routes, `POST /<path>/<action>` with the request as the body: `catalog` (any signed-in user: it holds no
 * rows), and `list`, `run`, `lookup`, `save`, `delete` behind `config.permission`. Every run is also scoped to the
 * user's company and row scope.
 */
export function reportsController(config: Pick<ReportsConfig, 'routes' | 'permission'>): Type<unknown> {
  const name = { ...ACTIONS, ...config.routes?.actions };
  const allowed: MethodDecorator = config.permission ? RequirePermission(...config.permission) : () => undefined;

  @Controller(config.routes?.path ?? 'reports')
  class ReportsController {
    constructor(private readonly reports: ReportService) {}

    @Post(name.catalog)
    @HttpCode(201)
    @Slot('fast', { readOnly: true })
    catalog() {
      return this.reports.catalog();
    }

    @Post(name.list)
    @HttpCode(201)
    @Slot('fast', { readOnly: true })
    @allowed
    list() {
      return this.reports.list(this.reports.user());
    }

    @Post(name.run)
    @HttpCode(201)
    @Slot('medium', { readOnly: true })
    @allowed
    run(@Body() request: Rdl2RunRequest) {
      return this.reports.run({ ...request }, this.reports.user());
    }

    @Post(name.lookup)
    @HttpCode(201)
    @Slot('fast', { readOnly: true })
    @allowed
    lookup(@Body() request: LookupRequest) {
      return this.reports.lookup({ ...request }, this.reports.user());
    }

    @Post(name.save)
    @HttpCode(201)
    @allowed
    save(@Body() request: SaveRequest) {
      return this.reports.save({ ...request }, this.reports.user());
    }

    @Post(name.delete)
    @HttpCode(201)
    @allowed
    delete(@Body() request: { id?: number }) {
      return this.reports.delete({ ...request }, this.reports.user());
    }
  }
  return ReportsController;
}

/**
 * The report engine and studio routes for a project: `ReportsModule.register({ store, user, … })` in the project's
 * module. Guide: `docs/reports.md`.
 */
@Module({})
export class ReportsModule {
  static register(config: ReportsConfig): DynamicModule {
    if (config.rowScope && !config.rowScopeSource) throw new Error('reports: rowScope needs a rowScopeSource (the values a user may read)');
    return {
      module: ReportsModule,
      imports: config.imports ?? [],
      controllers: [reportsController(config)],
      providers: [
        { provide: REPORTS_CONFIG, useValue: config },
        config.store,
        { provide: REPORT_STORE, useExisting: config.store },
        config.user,
        { provide: REPORT_USER_SOURCE, useExisting: config.user },
        ...(config.rowScopeSource ? [config.rowScopeSource, { provide: REPORT_ROW_SCOPE, useExisting: config.rowScopeSource }] : []),
        ReportCatalogService,
        ReportRunner,
        ReportService,
      ],
      exports: [ReportCatalogService, ReportRunner, ReportService],
    };
  }
}
