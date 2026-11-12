import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import type { PlacementStore, ShardInfo, TenantRoute } from '../features.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import type { TenantRef } from './context.js';
import { decryptSecret } from './control/shard-crypto.js';
import { TenantRouting } from './control/tenant-routing.model.js';
import { TenantShard } from './control/tenant-shard.model.js';

const plain = (row: TenantRouting): TenantRoute => ({
  companyId: row.companyId,
  tenantKey: null,
  dbKey: row.dbKey,
  schema: row.schema,
  status: row.status,
  epoch: row.epoch,
});

/**
 * `features.placement: 'tables'`: routes in the control plane's `tenant_routing`, databases in
 * `tenant_shards` (URIs encrypted with `secretKey`). `primary` needs no shard row.
 */
@Injectable()
export class TablePlacementStore implements PlacementStore {
  constructor(
    @InjectModel(TenantRouting) private readonly routing: typeof TenantRouting,
    @InjectModel(TenantShard) private readonly shards: typeof TenantShard,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
  ) {}

  async route(ref: TenantRef): Promise<TenantRoute | null> {
    const row = await this.routing.findOne({ where: { companyId: ref.companyId } });
    return row ? plain(row) : null;
  }

  async activeRoutes(): Promise<TenantRoute[]> {
    const rows = await this.routing.findAll({ where: { status: 'active' }, order: [['companyId', 'ASC']] });
    return rows.map(plain);
  }

  async shard(dbKey: string): Promise<ShardInfo | null> {
    const shard = await this.shards.findOne({ where: { dbKey } });
    if (!shard) return null;
    return {
      dbKey,
      uri: shard.connectionUri ? decryptSecret(shard.connectionUri, this.options.secretKey ?? '') : '',
      status: shard.status,
      type: shard.type,
      poolMax: shard.poolMax,
    };
  }
}
