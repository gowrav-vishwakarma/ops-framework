import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { PermissionCatalogService } from '../acl/permission-catalog.service.js';
import { TenantRouting } from './control/tenant-routing.model.js';
import type { Placement, TenantRef } from './context.js';
import { PlacementResolver } from './placement.js';
import { SchemaSync } from './schema-sync.js';
import { TenantRunner } from './tenant-runner.js';

export interface TenantProvisionInput {
  ref: TenantRef;
  /** Where the tenant's rows will live. `epoch` is taken from the route (1 for a new one). */
  placement: Pick<Placement, 'dbKey' | 'schema'>;
  /** Runs inside the new tenant's context after the schema and permission catalog exist (the company mirror row, default roles). */
  seed?: () => Promise<void>;
}

/** Creates a tenant's place: schema, tables, permission catalog, routing, then the app's own seed. */
@Injectable()
export class TenantLifecycle {
  private readonly logger = new Logger('TenantLifecycle');

  constructor(
    @InjectModel(TenantRouting) private readonly routing: typeof TenantRouting,
    private readonly schemas: SchemaSync,
    private readonly runner: TenantRunner,
    private readonly placements: PlacementResolver,
    @Optional() private readonly catalog?: PermissionCatalogService,
  ) {}

  /**
   * Safe to repeat: an existing schema is only brought up to date. The route is `creating` while it
   * runs and `active` only when everything succeeded, so a half-built tenant is never served.
   */
  async provision({ ref, placement, seed }: TenantProvisionInput): Promise<Placement> {
    const [route] = await this.routing.findOrCreate({
      where: { companyId: ref.companyId },
      defaults: { companyId: ref.companyId, dbKey: placement.dbKey, schema: placement.schema, epoch: 1, status: 'creating' } as never,
    });
    await this.schemas.syncTenant(placement.dbKey, placement.schema);
    const resolved: Placement = { dbKey: placement.dbKey, schema: placement.schema, epoch: route.epoch };
    await this.runner.run(
      ref,
      async () => {
        await this.catalog?.sync();
        await seed?.();
      },
      { placement: resolved },
    );
    await route.update({ status: 'active', dbKey: placement.dbKey, schema: placement.schema });
    await this.placements.changed(ref.companyId, { wait: false });
    this.logger.log(`Company ${ref.companyId} ready at ${placement.dbKey}.${placement.schema}`);
    return resolved;
  }
}
