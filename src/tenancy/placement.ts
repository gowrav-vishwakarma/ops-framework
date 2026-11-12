import { Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException, type OnModuleInit } from '@nestjs/common';
import { BUS_TOPICS, ClusterBus } from '../cluster/cluster-bus.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { PLACEMENT_STORE, type PlacementStore, type TenantRoute } from '../features.js';
import type { Placement, TenantRef } from './context.js';
import { PRIMARY } from './connection-registry.js';

export interface ResolveOptions {
  /** Provisioning and moves read the route whatever its status. */
  ignoreStatus?: boolean;
}

interface Cached {
  at: number;
  value: Placement;
  /** The route's tenant key, to refuse a token naming another tenant on a cache hit too. */
  tenantKey?: string | null;
}

/**
 * Turns a tenant into `{ dbKey, schema, epoch }`. Fails closed: a missing route is a 404, a route
 * that is creating, moving or disabled is a 503. It never falls back to the primary database.
 *
 * Routes are cached per process. A change goes to every process through the cluster bus
 * (`changed()`); the TTL is the backstop for a process that missed the message.
 */
@Injectable()
export class PlacementResolver implements OnModuleInit {
  private readonly cache = new Map<number, Cached>();

  constructor(
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    @Optional() @Inject(PLACEMENT_STORE) private readonly store?: PlacementStore,
    @Optional() private readonly bus?: ClusterBus,
  ) {}

  onModuleInit(): void {
    this.bus?.subscribe<{ companyId?: number }>(BUS_TOPICS.placement, ({ companyId }) => this.invalidate(companyId));
  }

  /** How long a cached route may live in a process. */
  get cacheMs(): number {
    const config = this.options.tenancy.placement;
    return config.strategy === 'routed' ? (config.cacheMs ?? 30_000) : 0;
  }

  /**
   * Tells every process the route of `companyId` changed, and resolves once no process can still
   * be using the old one: right after delivery with a distributed bus, after the cache TTL without
   * (other processes may exist that the local bus cannot reach). `wait: false` only announces.
   */
  async changed(companyId: number, options: { wait?: boolean } = {}): Promise<void> {
    this.invalidate(companyId);
    await this.bus?.publish(BUS_TOPICS.placement, { companyId });
    if (options.wait === false) return;
    await sleep(this.bus?.distributed ? this.bus.settleMs : this.cacheMs + 1_000);
  }

  async resolve(ref: TenantRef, resolveOptions: ResolveOptions = {}): Promise<Placement> {
    const config = this.options.tenancy.placement;
    if (config.strategy === 'single') return { dbKey: config.dbKey ?? PRIMARY, schema: config.schema, epoch: 1 };
    if (config.strategy === 'schemaPerTenant') return { dbKey: config.dbKey ?? PRIMARY, schema: `${config.prefix}${ref.companyId}`, epoch: 1 };

    const ttl = this.cacheMs;
    const hit = this.cache.get(ref.companyId);
    if (hit && Date.now() - hit.at < ttl && !resolveOptions.ignoreStatus) {
      // The same answer as an uncached resolve: a token naming another tenant is refused either way.
      if (ref.tenantKey && hit.tenantKey && ref.tenantKey !== hit.tenantKey) throw new NotFoundException('Company not found');
      return hit.value;
    }

    const row = await this.routes().route(ref);
    if (!row) throw new NotFoundException('Company not found');
    if (ref.tenantKey && row.tenantKey && ref.tenantKey !== row.tenantKey) throw new NotFoundException('Company not found');
    if (row.status !== 'active' && !resolveOptions.ignoreStatus) {
      this.cache.delete(ref.companyId);
      throw new ServiceUnavailableException(row.status === 'migrating' ? 'This company is being moved. Try again in a moment.' : `Company is ${row.status}`);
    }
    const value: Placement = { dbKey: row.dbKey, schema: row.schema, epoch: row.epoch };
    if (row.status === 'active') this.cache.set(ref.companyId, { at: Date.now(), value, tenantKey: row.tenantKey ?? null });
    return value;
  }

  /** After a routing change. Without an id, everything. */
  invalidate(companyId?: number): void {
    if (companyId === undefined) this.cache.clear();
    else this.cache.delete(companyId);
  }

  /** Active routes, for boot sync and `forEach` over every tenant. */
  async activeRoutes(): Promise<TenantRoute[]> {
    return this.routes().activeRoutes();
  }

  private routes(): PlacementStore {
    if (!this.store) throw new Error("tenancy.placement 'routed' needs features.placement ('tables' or the project's PlacementStore)");
    return this.store;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
