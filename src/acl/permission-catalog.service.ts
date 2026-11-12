import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/sequelize';
import { Op, type Transaction } from 'sequelize';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { sequelizeOf } from '../tenancy/guards.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import { PermissionMeta, type LimitInfo } from './limits.js';
import { Permission } from './permission.model.js';

export interface CatalogItem {
  id: number;
  resource: string;
  action: string;
  code: string;
  label: string;
  groupName: string;
  /** Scope ids the matrix offers for this permission. */
  scopes: readonly string[];
  /** Limits a grant of this permission can carry; empty when none. */
  limits: readonly LimitInfo[];
  /** The action asked to stay out of the matrix (`hideInAcl`). */
  hidden: boolean;
}

/**
 * Keeps the `permissions` table of the current tenant's schema equal to the code catalog, and
 * system roles holding all of it. Run inside a tenant context (boot, provisioning).
 */
@Injectable()
export class PermissionCatalogService {
  private readonly logger = new Logger(PermissionCatalogService.name);

  constructor(
    @InjectModel(Permission) private readonly permissions: typeof Permission,
    private readonly db: TenantDb,
    private readonly meta: PermissionMeta,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
  ) {}

  async sync(outer?: Transaction): Promise<void> {
    const catalog = this.options.catalog;
    const run = async (t: Transaction) => {
      await this.permissions.bulkCreate(
        catalog.map(({ resource, action, code, label, groupName, sortOrder }) => ({ resource, action, code, label, groupName, sortOrder })),
        { updateOnDuplicate: ['resource', 'action', 'label', 'groupName', 'sortOrder', 'updatedAt'], conflictAttributes: ['code'], transaction: t },
      );
      const removed = await this.permissions.destroy({ where: { code: { [Op.notIn]: catalog.map((entry) => entry.code) } }, transaction: t });
      await sequelizeOf(t).query(
        `INSERT INTO role_permissions (company_id, role_id, permission_id, scope, limits, created_at, updated_at)
         SELECT r.company_id, r.id, p.id, 'all', '{}'::jsonb, now(), now() FROM roles r CROSS JOIN permissions p WHERE r.is_system
         ON CONFLICT (company_id, role_id, permission_id) DO NOTHING`,
        { transaction: t },
      );
      this.logger.log(`Permission catalog synced: ${catalog.length} entries, ${removed} removed`);
    };
    return outer ? run(outer) : this.db.tx(run);
  }

  /** Limits a grant of `code` can carry: those the catalog names plus those a service enforces. */
  limitsOf(code: string): LimitInfo[] {
    const byKey = new Map<string, LimitInfo>();
    for (const limit of this.options.catalog.find((entry) => entry.code === code)?.limits ?? []) byKey.set(limit.key, limit);
    for (const limit of this.meta.limits(code)) byKey.set(limit.key, limit);
    return [...byKey.values()];
  }

  /** The matrix: groups of permissions with their scopes and limits. */
  async grouped(): Promise<Array<{ group: string; items: CatalogItem[] }>> {
    const rows = await this.permissions.findAll({ order: [['sortOrder', 'ASC']] });
    const declared = new Map(this.options.catalog.map((entry) => [entry.code, entry]));
    const groups = new Map<string, CatalogItem[]>();
    for (const row of rows) {
      const list = groups.get(row.groupName) ?? [];
      list.push({
        id: row.id as number,
        resource: row.resource,
        action: row.action,
        code: row.code,
        label: row.label,
        groupName: row.groupName,
        scopes: declared.get(row.code)?.scopes ?? ['all'],
        limits: this.limitsOf(row.code),
        hidden: this.meta.isHidden(row.code),
      });
      groups.set(row.groupName, list);
    }
    return [...groups].map(([group, items]) => ({ group, items }));
  }
}
