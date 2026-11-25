import { Injectable } from '@nestjs/common';
import { ConnectionRegistry } from './connection-registry.js';
import { runWithTenant, type Placement, type TenantRef } from './context.js';
import { PlacementResolver } from './placement.js';

/**
 * Work outside a request: schedulers, `afterCommit` jobs, seeds, imports. It sets the tenant the
 * same way the guard does for a request, so models, `c.t` and `TenantDb` behave identically.
 * Across shards, `forEach` opens each tenant's own connection.
 */
@Injectable()
export class TenantRunner {
  constructor(
    private readonly placements: PlacementResolver,
    private readonly registry: ConnectionRegistry,
  ) {}

  /** `runInTenant`: runs `work` for one tenant. `placement` skips the lookup (provisioning, moves). */
  async run<T>(ref: TenantRef, work: () => Promise<T>, options: { placement?: Placement } = {}): Promise<T> {
    const placement = options.placement ?? (await this.placements.resolve(ref));
    const sequelize = await this.registry.get(placement.dbKey);
    return runWithTenant({ ref, placement, sequelize }, work);
  }

  /**
   * `forEachTenant`: every active tenant, one after the other. A failing tenant is reported, the rest still run.
   * `label` names the job in each failure, so a caller collecting several jobs' failures can tell them apart.
   */
  async forEach(work: (ref: TenantRef) => Promise<void>, options: { label?: string } = {}): Promise<TenantFailure[]> {
    const failures: TenantFailure[] = [];
    for (const route of await this.placements.activeRoutes()) {
      const ref = { companyId: route.companyId };
      try {
        await this.run(ref, () => work(ref), { placement: { dbKey: route.dbKey, schema: route.schema, epoch: route.epoch } });
      } catch (error) {
        failures.push({ companyId: route.companyId, error, ...(options.label ? { label: options.label } : {}) });
      }
    }
    return failures;
  }
}

/** A tenant `TenantRunner.forEach` could not run `work` for. */
export interface TenantFailure {
  companyId: number;
  error: unknown;
  /** The `label` given to `forEach`. */
  label?: string;
}
