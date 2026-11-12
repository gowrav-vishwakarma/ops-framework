import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { PermissionCatalogService } from '../acl/permission-catalog.service.js';
import { AdminCatalogService } from '../admin/admin-catalog.service.js';
import { NAMES } from '../naming.js';
import { TenantRunner } from '../tenancy/tenant-runner.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { ConnectionRegistry, PRIMARY } from '../tenancy/connection-registry.js';
import { quoteIdent } from '../tenancy/context.js';
import { TenantRouting } from '../tenancy/control/tenant-routing.model.js';
import { markTx } from '../tenancy/guards.js';
import { SchemaSync } from '../tenancy/schema-sync.js';
import type { MigrationContext, MigrationFile, MigrationTarget } from './migration.js';
import { MigrationFiles, loadMigration } from './migration-files.js';
import { schemaQueryInterface } from './schema-qi.js';
import { appliedNames, ensureMeta, forget, hasMeta, lockSchema, recordApplied } from './meta.js';

/** One schema the runner looks after. */
export interface MigrationPlace {
  target: MigrationTarget;
  dbKey: string;
  schema: string;
}

export interface PlaceStatus extends MigrationPlace {
  /** No migration table yet: the next run creates the tables from the models and marks every migration applied. */
  fresh: boolean;
  applied: number;
  pending: string[];
}

/** Narrows a run: one side, one database, one schema, or any test of the place. */
export interface PlaceFilter {
  only?: MigrationTarget;
  dbKey?: string;
  schema?: string;
  where?: (place: MigrationPlace) => boolean;
}

const matches = (place: MigrationPlace, filter: PlaceFilter) =>
  (!filter.only || place.target === filter.only) &&
  (!filter.dbKey || place.dbKey === filter.dbKey) &&
  (!filter.schema || place.schema === filter.schema) &&
  (!filter.where || filter.where(place));

export interface PlaceReport extends MigrationPlace {
  /** `created` when the schema was built from the models. */
  created: boolean;
  ran: string[];
  error?: string;
}

/**
 * Brings the control plane and every tenant schema (every route, on every shard) up to the app's
 * migrations. Run it as a one-off job before a deploy (`npm run migrate`), never from app boot.
 *
 * - A schema without a migration table is new: its tables are created from the models and every
 *   migration is recorded as applied (the models already have their changes).
 * - Otherwise each pending migration runs in its own transaction with `search_path` set to the
 *   schema and is recorded in that same transaction. An advisory lock per schema lets two runners
 *   start together without running a migration twice.
 * - A failing tenant schema is reported and the others continue; the control plane goes first and
 *   stops the run when it fails.
 */
@Injectable()
export class MigrationRunner {
  private readonly logger = new Logger('Migrations');

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly schemas: SchemaSync,
    private readonly files: MigrationFiles,
    @InjectModel(TenantRouting) private readonly routing: typeof TenantRouting,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    private readonly catalogs?: { admin?: AdminCatalogService; tenant?: PermissionCatalogService; runner: TenantRunner },
  ) {}

  /** The control plane, then every distinct `(dbKey, schema)` tenants live in. */
  async places(): Promise<MigrationPlace[]> {
    const places: MigrationPlace[] = [{ target: 'control', dbKey: this.registry.controlKey, schema: NAMES.controlSchema }];
    const seen = new Set<string>();
    const add = (dbKey: string, schema: string) => {
      if (seen.has(`${dbKey}.${schema}`)) return;
      seen.add(`${dbKey}.${schema}`);
      places.push({ target: 'tenant', dbKey, schema });
    };
    const placement = this.options.tenancy.placement;
    if (placement.strategy === 'single') add(placement.dbKey ?? PRIMARY, placement.schema);
    if (await hasMeta(this.registry.control, NAMES.controlSchema)) {
      const routes = await this.routing.findAll({ attributes: ['dbKey', 'schema'], order: [['dbKey', 'ASC'], ['schema', 'ASC']] });
      for (const route of routes) add(route.dbKey, route.schema);
    }
    return places;
  }

  async status(filter: PlaceFilter = {}): Promise<PlaceStatus[]> {
    const out: PlaceStatus[] = [];
    for (const place of (await this.places()).filter((p) => matches(p, filter))) {
      const sequelize = await this.connectionOf(place);
      const fresh = !(await hasMeta(sequelize, place.schema));
      const applied = await appliedNames(sequelize, place.schema);
      const pending = fresh ? [] : this.files.list(place.target).filter((file) => !applied.has(file.name)).map((file) => file.name);
      out.push({ ...place, fresh, applied: applied.size, pending });
    }
    return out;
  }

  /** The control plane first (a failure there stops the run), then every tenant place the filter keeps. */
  async up(filter: PlaceFilter = {}): Promise<PlaceReport[]> {
    const reports: PlaceReport[] = [];
    const control = (await this.places())[0] as MigrationPlace;
    if (matches(control, filter)) {
      const report = await this.migrate(control);
      reports.push(report);
      if (report.error) return reports;
    }
    for (const place of (await this.places()).filter((p) => p.target === 'tenant' && matches(p, filter))) reports.push(await this.migrate(place));
    return reports;
  }

  /** Undoes the last applied migration of one schema with its `down`. Local development only. */
  async undoLast(place: MigrationPlace): Promise<string | null> {
    if (process.env.NODE_ENV === 'production') throw new Error('Undoing a migration is for local development only');
    const sequelize = await this.connectionOf(place);
    const applied = await appliedNames(sequelize, place.schema);
    const last = this.files.list(place.target).filter((file) => applied.has(file.name)).at(-1);
    if (!last) return null;
    const definition = await loadMigration(last);
    if (!definition.down) throw new Error(`${last.name} has no down()`);
    await this.inSchema(sequelize, place, async (context) => {
      await definition.down!(context);
      await forget(sequelize, place.schema, last.name, context.t);
    });
    return last.name;
  }

  private async migrate(place: MigrationPlace): Promise<PlaceReport> {
    const report: PlaceReport = { ...place, created: false, ran: [] };
    try {
      const sequelize = await this.connectionOf(place);
      if (!(await hasMeta(sequelize, place.schema))) {
        if (place.target === 'control') await this.schemas.syncControl({ create: true });
        else await this.schemas.syncTenant(place.dbKey, place.schema);
        report.created = true;
        this.logger.log(`${place.dbKey}.${place.schema}: created from the models`);
      } else {
        const applied = await appliedNames(sequelize, place.schema);
        for (const file of this.files.list(place.target).filter((f) => !applied.has(f.name))) {
          if (await this.apply(sequelize, place, file)) report.ran.push(file.name);
        }
        if (report.ran.length) this.logger.log(`${place.dbKey}.${place.schema}: ran ${report.ran.join(', ')}`);
      }
      await this.syncCatalog(place);
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      this.logger.error(`${place.dbKey}.${place.schema}: ${report.error}`);
    }
    return report;
  }

  /** The permission catalog of the place follows the code: new permissions reach every schema with the deploy. */
  private async syncCatalog(place: MigrationPlace): Promise<void> {
    if (!this.catalogs) return;
    if (place.target === 'control') return this.catalogs.admin?.sync();
    const tenant = this.catalogs.tenant;
    if (!tenant) return;
    await this.catalogs.runner.run({ companyId: 0 }, () => tenant.sync(), { placement: { dbKey: place.dbKey, schema: place.schema, epoch: 0 } });
  }

  /** Runs one migration unless another runner got there first. */
  private async apply(sequelize: Sequelize, place: MigrationPlace, file: MigrationFile): Promise<boolean> {
    const definition = await loadMigration(file);
    return this.inSchema(sequelize, place, async (context) => {
      if ((await appliedNames(sequelize, place.schema, context.t)).has(file.name)) return false;
      await definition.up(context);
      await ensureMeta(sequelize, place.schema, context.t);
      await recordApplied(sequelize, place.schema, [file.name], context.t);
      return true;
    });
  }

  private inSchema<T>(sequelize: Sequelize, place: MigrationPlace, work: (context: MigrationContext) => Promise<T>): Promise<T> {
    return sequelize.transaction(async (t) => {
      markTx(t, { kind: place.target === 'control' ? 'control' : 'tenant', dbKey: place.dbKey });
      await sequelize.query(`SET LOCAL search_path TO ${quoteIdent(place.schema)}`, { transaction: t });
      await lockSchema(sequelize, place.schema, t);
      return work({
        qi: schemaQueryInterface(sequelize.getQueryInterface(), place.schema),
        t,
        sequelize,
        schema: place.schema,
        dbKey: place.dbKey,
        sql: (statement, replacements) => sequelize.query(statement, { replacements, transaction: t }),
      });
    });
  }

  private connectionOf(place: MigrationPlace): Promise<Sequelize> {
    return place.target === 'control' ? Promise.resolve(this.registry.control) : this.registry.get(place.dbKey);
  }
}
