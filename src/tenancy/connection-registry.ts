import { Inject, Injectable, Logger, Optional, ServiceUnavailableException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { installCompanySqlCheck } from './company-sql.js';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { NAMES } from '../naming.js';
import { installQueryCapture } from '../logging/query-capture.js';
import { sqlLogger } from '../logging/request-log.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { FRAMEWORK_FEATURES, PLACEMENT_STORE, type PlacementStore, type ResolvedFeatures } from '../features.js';
import { installDdlGuard, installQueryGuards } from './guards.js';
import { bindTenantModels, controlModelsOf, tenantModelsOf } from './model-binding.js';

export const PRIMARY = 'primary';
export const CONTROL = 'control';

/** Tenant connections start with no usable schema: raw SQL that skips `c.t` / `TenantDb` fails loudly. */
export const UNSET_SEARCH_PATH = 'tenant_unset';

/** RDS Proxy and pgbouncer endpoints refuse startup options such as `search_path`. */
export function isPooler(uri: string | undefined): boolean {
  if (!uri) return false;
  return /\.proxy-[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com/i.test(uri) || /[?&]pooler=(true|1)/i.test(uri);
}

function needsSsl(uri: string | undefined): boolean {
  return !!uri && (/\.rds\.amazonaws\.com/i.test(uri) || /[?&]sslmode=(require|verify-ca|verify-full)/i.test(uri));
}

/**
 * Connection options every pool shares. Directly connected pools start with an unusable
 * `search_path`, so raw SQL that skips the tenant transaction fails loudly. Behind a pooler (RDS
 * Proxy, pgbouncer), which refuses startup options, set the same default on the database role
 * instead: `ALTER ROLE <app user> SET search_path = tenant_unset` (checked at boot, see `checkSearchPath`).
 */
export function connectionOptions(poolMax: number, uri?: string, logging: false | ((sql: string, timing?: number) => void) = false) {
  const pooler = isPooler(uri);
  const ssl = needsSsl(uri) || pooler;
  return {
    dialect: 'postgres' as const,
    logging,
    benchmark: logging !== false,
    define: { underscored: NAMES.underscored },
    pool: { max: poolMax, min: 0, idle: 10_000, acquire: 30_000 },
    dialectOptions: {
      ...(pooler ? {} : { options: `-c search_path=${UNSET_SEARCH_PATH}` }),
      ...(ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {}),
    },
  };
}

/** Warns when a pool's default `search_path` is not the unusable one (a pooler without the role default). */
export async function checkSearchPath(sequelize: Sequelize, dbKey: string, logger: Logger): Promise<void> {
  const [row] = await sequelize.query<{ search_path: string }>('SHOW search_path', { type: QueryTypes.SELECT });
  if (row && row.search_path.replace(/"/g, '') !== UNSET_SEARCH_PATH) {
    logger.warn(
      `Database "${dbKey}" starts with search_path "${row.search_path}": raw SQL outside a tenant transaction would not fail. ` +
        `Run: ALTER ROLE current_user SET search_path = ${UNSET_SEARCH_PATH}`,
    );
  }
}

/**
 * One pool per `dbKey`. The Nest connection is adopted as `primary`, so there is never a second
 * pool to the same database. Other shards are opened on first use (with an init lock so two
 * requests do not open two pools) from the URI in the control plane's `tenant_shards`, and the
 * already-initialised model classes are registered on them, never initialised again.
 */
export interface PoolStats {
  dbKey: string;
  /** Open connections, in use, idle, and requests waiting for one. */
  size: number;
  using: number;
  available: number;
  waiting: number;
  max: number;
  idleMs: number;
}

@Injectable()
export class ConnectionRegistry implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger('Connections');
  private readonly instances = new Map<string, Sequelize>();
  private readonly opening = new Map<string, Promise<Sequelize>>();
  private readonly lastUsed = new Map<string, number>();
  private controlInstance: Sequelize | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    @InjectConnection() private readonly primary: Sequelize,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    @Optional() @Inject(PLACEMENT_STORE) private readonly store?: PlacementStore,
    @Optional() @Inject(FRAMEWORK_FEATURES) private readonly features?: ResolvedFeatures,
  ) {
    this.instances.set(PRIMARY, primary);
    this.guard(primary, PRIMARY, this.toucher(PRIMARY));
    bindTenantModels(primary, () => this.control);
  }

  async onModuleInit(): Promise<void> {
    await this.openControl();
    await checkSearchPath(this.primary, PRIMARY, this.logger).catch(() => undefined);
    const idleMs = this.options.shardIdleMs ?? 10 * 60_000;
    this.sweeper = setInterval(() => void this.closeIdle(idleMs), Math.min(idleMs, 60_000));
    this.sweeper.unref();
  }

  /** Query guards on a pool, and the DDL guard when another system owns the schema. */
  private guard(sequelize: Sequelize, dbKey: string, onQuery?: () => void): void {
    installQueryGuards(sequelize, dbKey, onQuery);
    installCompanySqlCheck(sequelize, this.options.tenancy.companySql ?? 'off', () => Object.values(this.primary.models) as never);
    if (this.features?.schema === 'external') installDdlGuard(sequelize, dbKey);
    if (this.options.logging?.queryCapture) installQueryCapture(sequelize, dbKey, this.options.logging.queryCapture);
  }

  private toucher(dbKey: string): () => void {
    return () => this.lastUsed.set(dbKey, Date.now());
  }

  /**
   * Closes shard pools nobody used for `idleMs`, so a pod that served a company once does not keep
   * its connections forever. The primary and control pools stay. Every query marks its pool as
   * used, so a long job that keeps querying keeps its pool open.
   */
  async closeIdle(idleMs: number): Promise<string[]> {
    const closed: string[] = [];
    for (const [dbKey, sequelize] of this.instances) {
      if (dbKey === PRIMARY || this.opening.has(dbKey)) continue;
      if (Date.now() - (this.lastUsed.get(dbKey) ?? 0) < idleMs) continue;
      this.instances.delete(dbKey);
      this.lastUsed.delete(dbKey);
      await sequelize.close().catch((error: unknown) => this.logger.error(`Closing "${dbKey}" failed: ${String(error)}`));
      closed.push(dbKey);
      this.logger.log(`Closed idle database pool "${dbKey}"`);
    }
    return closed;
  }

  /** Pool usage per open database, for health and capacity checks. */
  stats(): PoolStats[] {
    return [...this.instances].map(([dbKey, sequelize]) => {
      const pool = (sequelize.connectionManager as unknown as { pool?: { size: number; using: number; available: number; waiting: number; maxSize: number } }).pool;
      return {
        dbKey,
        size: pool?.size ?? 0,
        using: pool?.using ?? 0,
        available: pool?.available ?? 0,
        waiting: pool?.waiting ?? 0,
        max: pool?.maxSize ?? (sequelize.options.pool?.max as number) ?? 0,
        idleMs: Date.now() - (this.lastUsed.get(dbKey) ?? Date.now()),
      };
    });
  }

  /** The connection of the control plane: the primary pool unless `controlDbUri` is set. */
  get control(): Sequelize {
    return this.controlInstance ?? this.primary;
  }

  /** The dbKey the control plane's connection answers to (for transaction marks and guards). */
  get controlKey(): string {
    return this.controlInstance ? CONTROL : PRIMARY;
  }

  /** Opens the separate control database when configured. Called once at boot, before any request. */
  async openControl(): Promise<void> {
    if (!this.options.controlDbUri || this.controlInstance) return;
    const sequelize = new Sequelize(this.options.controlDbUri, connectionOptions(5, this.options.controlDbUri, sqlLogger(this.options, CONTROL)));
    this.register(sequelize, controlModelsOf(this.primary));
    this.guard(sequelize, CONTROL);
    await sequelize.authenticate();
    await checkSearchPath(sequelize, CONTROL, this.logger).catch(() => undefined);
    this.controlInstance = sequelize;
    this.logger.log('Control plane runs on its own database');
  }

  /** Connection for `dbKey`; refuses a shard that is not active. */
  async get(dbKey: string): Promise<Sequelize> {
    const hit = this.instances.get(dbKey);
    if (hit) {
      this.lastUsed.set(dbKey, Date.now());
      return hit;
    }
    const pending = this.opening.get(dbKey);
    if (pending) return pending;
    const opening = this.open(dbKey).finally(() => this.opening.delete(dbKey));
    this.opening.set(dbKey, opening);
    return opening;
  }

  private async open(dbKey: string): Promise<Sequelize> {
    const shard = this.store ? await this.store.shard(dbKey) : null;
    if (!shard) throw new ServiceUnavailableException(`Unknown database "${dbKey}"`);
    if (shard.status !== 'active' && shard.status !== 'standby') throw new ServiceUnavailableException(`Database "${dbKey}" is ${shard.status}`);
    if (!shard.uri) throw new ServiceUnavailableException(`Database "${dbKey}" has no connection`);
    const pools = { cloud: 30, onprem: 10, ...this.options.shardPool };
    const uri = shard.uri;
    const sequelize = new Sequelize(uri, connectionOptions(shard.poolMax ?? pools[shard.type], uri, sqlLogger(this.options, dbKey)));
    // Register the shared model classes without re-initialising them: init would repoint every
    // other request in the process at this shard.
    this.register(sequelize, tenantModelsOf(this.primary));
    this.guard(sequelize, dbKey, this.toucher(dbKey));
    await sequelize.authenticate();
    await checkSearchPath(sequelize, dbKey, this.logger).catch(() => undefined);
    this.instances.set(dbKey, sequelize);
    this.lastUsed.set(dbKey, Date.now());
    this.logger.log(`Opened database "${dbKey}"`);
    return sequelize;
  }

  private register(sequelize: Sequelize, models: ReturnType<typeof tenantModelsOf>): void {
    for (const model of models) {
      sequelize.modelManager.addModel(model as never);
      (sequelize.models as Record<string, unknown>)[model.name] = model;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    for (const [key, sequelize] of this.instances) if (key !== PRIMARY) await sequelize.close();
    await this.controlInstance?.close();
  }
}
