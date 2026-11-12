import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { FRAMEWORK_FEATURES, type ResolvedFeatures } from '../features.js';
import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { NAMES } from '../naming.js';
import { ensureMeta, hasMeta, lockSchema, recordApplied } from '../migrations/meta.js';
import { MigrationFiles } from '../migrations/migration-files.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { ConnectionRegistry } from './connection-registry.js';
import { quoteIdent, runWithTenant } from './context.js';
import { markTx } from './guards.js';
import { controlModelsOf, tenantModelsOf } from './model-binding.js';
import { orderByDependencies, undeclaredIdColumns } from './ref-graph.js';

/** `create`: build the control plane when it has no migration table yet (the migration job does). */
export interface SyncOptions {
  create?: boolean;
}

/**
 * Creates tables from the models, one schema at a time. Nest's own `synchronize` is off: it would
 * try to create every table in the default schema, and the foreign key to the `companies` mirror
 * has to resolve inside the schema being built. Each schema is synced in one transaction whose
 * `search_path` is that schema, holding the schema's advisory lock (the one migrations take), so two
 * processes starting together never alter the same tables at once.
 *
 * A schema without a migration table is new: it is built from the models and every migration is
 * recorded as applied in the same transaction. An existing schema changes only through migrations
 * (`MigrationRunner`); with `dbSync: 'alter'` (local development) the models are applied to it too.
 */
@Injectable()
export class SchemaSync {
  private readonly logger = new Logger('SchemaSync');
  private readonly parity = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly files: MigrationFiles,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    @Optional() @Inject(FRAMEWORK_FEATURES) private readonly features?: ResolvedFeatures,
  ) {}

  /** `features.schema: 'external'`: another system migrates these schemas; building, altering or dropping them here is an error. */
  private refuseWhenExternal(): void {
    if (this.features?.schema === 'external') throw new Error('Schema changes are refused: features.schema is external (another system owns and migrates this schema)');
  }

  private get alter(): boolean {
    return this.options.dbSync === 'alter';
  }

  /** The control plane's tables, in the `platform` schema. */
  async syncControl(options: SyncOptions = {}): Promise<void> {
    this.refuseWhenExternal();
    const sequelize = this.registry.control;
    const schema = NAMES.controlSchema;
    const fresh = !(await hasMeta(sequelize, schema));
    if (!fresh && !this.alter) return;
    if (fresh && !this.alter && !options.create) throw new Error(`Schema "${schema}" has no migration table: run the migration job first`);
    await sequelize.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    const models = orderByDependencies(controlModelsOf(this.registry.control));
    await sequelize.transaction(async (t) => {
      markTx(t, { kind: 'control', dbKey: this.registry.controlKey });
      await sequelize.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`, { transaction: t });
      await lockSchema(sequelize, schema, t);
      for (const model of models) await model.sync({ alter: this.alter, transaction: t } as never);
      if (fresh) await this.baseline(sequelize, schema, 'control', t);
    });
  }

  /** A schema built from the models already has every migration's change. */
  private async baseline(sequelize: Sequelize, schema: string, target: 'control' | 'tenant', t: Transaction): Promise<void> {
    await ensureMeta(sequelize, schema, t);
    await recordApplied(sequelize, schema, this.files.list(target).map((file) => file.name), t);
  }

  /**
   * Every tenant table, in `schema` of `dbKey`. A new schema is created (provisioning a company into
   * its own schema, or a new shard); an existing one is only checked against the models, unless
   * `dbSync` is `alter`.
   */
  async syncTenant(dbKey: string, schema: string): Promise<void> {
    this.refuseWhenExternal();
    const sequelize = await this.registry.get(dbKey);
    const fresh = !(await hasMeta(sequelize, schema));
    if (!fresh && !this.alter) {
      this.parity.delete(`${dbKey}:${schema}`);
      return this.checkParity(sequelize, dbKey, schema);
    }
    const problems = undeclaredIdColumns(tenantModelsOf(sequelize));
    const strictness = this.options.refs?.undeclared ?? 'warn';
    if (problems.length && strictness !== 'off') {
      const message = `Undeclared id columns (declare a foreign key, @SoftRef or @NotARef): ${problems.join(', ')}`;
      if (strictness === 'error') throw new Error(message);
      this.logger.warn(message);
    }
    await sequelize.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    const models = orderByDependencies(tenantModelsOf(sequelize));
    // Models read the schema from the tenant context, so the context for a sync is the schema itself.
    await runWithTenant({ ref: { companyId: 0 }, placement: { dbKey, schema, epoch: 0 }, sequelize }, () =>
      sequelize.transaction(async (t) => {
        markTx(t, { kind: 'tenant', dbKey });
        await sequelize.query(`SET LOCAL search_path TO ${quoteIdent(schema)}`, { transaction: t });
        await lockSchema(sequelize, schema, t);
        for (const model of models) await model.sync({ alter: this.alter, transaction: t } as never);
        if (fresh) await this.baseline(sequelize, schema, 'tenant', t);
      }),
    );
    this.parity.delete(`${dbKey}:${schema}`);
    this.logger.log(`Synced ${models.length} tables in ${dbKey}.${schema}`);
  }

  /** Drops a tenant schema (tests and `db:reset`). */
  async dropSchema(dbKey: string, schema: string): Promise<void> {
    this.refuseWhenExternal();
    const sequelize = await this.registry.get(dbKey);
    await sequelize.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    this.parity.delete(`${dbKey}:${schema}`);
  }

  /**
   * Once per `(dbKey, schema)`: every table and column the models need exists. A lagging schema
   * would fail later with a confusing "column does not exist", so that tenant gets a 503 instead.
   */
  checkParity(sequelize: Sequelize, dbKey: string, schema: string): Promise<void> {
    const mode = this.options.schemaParity ?? (this.features?.schema === 'external' ? 'warn' : 'block');
    if (mode === 'off') return Promise.resolve();
    const key = `${dbKey}:${schema}`;
    const known = this.parity.get(key);
    if (known) return known;
    const check = this.compare(sequelize, schema).catch((error: unknown) => {
      if (mode === 'warn' && error instanceof ServiceUnavailableException) {
        // Reported once per schema; the requests go on (queries on the missing columns still fail).
        this.logger.warn(`${dbKey}.${schema}: ${error.message}`);
        return;
      }
      this.parity.delete(key);
      throw error;
    });
    this.parity.set(key, check);
    return check;
  }

  private async compare(sequelize: Sequelize, schema: string): Promise<void> {
    const rows = await sequelize.query<{ table_name: string; column_name: string }>(
      'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = :schema',
      { replacements: { schema }, type: QueryTypes.SELECT },
    );
    const have = new Map<string, Set<string>>();
    for (const row of rows) have.set(row.table_name, (have.get(row.table_name) ?? new Set()).add(row.column_name));
    const missing: string[] = [];
    for (const model of tenantModelsOf(sequelize)) {
      const columns = have.get(model.tableName);
      if (!columns) {
        missing.push(model.tableName);
        continue;
      }
      for (const [attribute, definition] of Object.entries(model.getAttributes())) {
        const field = (definition as { field?: string }).field ?? attribute;
        if (!columns.has(field)) missing.push(`${model.tableName}.${field}`);
      }
    }
    if (missing.length) {
      throw new ServiceUnavailableException(`Database schema "${schema}" is out of date (missing ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` and ${missing.length - 20} more` : ''}). Run the migration.`);
    }
  }
}
