import { Inject, Injectable, Logger } from '@nestjs/common';
import { Op, type Transaction } from 'sequelize';
import type { CatalogItem } from '../acl/permission-catalog.service.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { sequelizeOf } from '../tenancy/guards.js';
import { ControlPlane } from '../tenancy/tenant-db.js';
import { AdminPermissionMeta } from './admin-acl.service.js';
import { AdminPermission } from './admin-permission.model.js';
import { AdminRole } from './admin-role.model.js';

/**
 * Keeps `admin_permissions` equal to `FrameworkOptions.admin.catalog`, makes sure a system role
 * exists, and gives every system role all of it. Run by the migration job and at dev boot.
 */
@Injectable()
export class AdminCatalogService {
  private readonly logger = new Logger('AdminCatalog');

  constructor(
    private readonly control: ControlPlane,
    private readonly meta: AdminPermissionMeta,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
  ) {}

  get catalog() {
    return this.options.admin?.catalog ?? [];
  }

  async sync(outer?: Transaction): Promise<void> {
    if (!this.options.admin) return;
    const catalog = this.catalog;
    const run = async (t: Transaction) => {
      if (catalog.length) {
        await AdminPermission.bulkCreate(
          catalog.map(({ resource, action, code, label, groupName, sortOrder }) => ({ resource, action, code, label, groupName, sortOrder })),
          { updateOnDuplicate: ['resource', 'action', 'label', 'groupName', 'sortOrder', 'updatedAt'], conflictAttributes: ['code'], transaction: t },
        );
      }
      await AdminPermission.destroy({ where: { code: { [Op.notIn]: catalog.map((entry) => entry.code).concat('') } }, transaction: t });
      if (!(await AdminRole.count({ where: { isSystem: true }, transaction: t }))) {
        await AdminRole.create({ code: 'SUPER_ADMIN', name: 'Super admin', description: 'Every admin permission', isSystem: true } as never, { transaction: t });
      }
      await sequelizeOf(t).query(
        `INSERT INTO admin_role_permissions (role_id, permission_id, scope, limits, created_at, updated_at)
         SELECT r.id, p.id, 'all', '{}'::jsonb, now(), now() FROM admin_roles r CROSS JOIN admin_permissions p WHERE r.is_system
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        { transaction: t },
      );
      this.logger.log(`Admin permission catalog synced: ${catalog.length} entries`);
    };
    return outer ? run(outer) : this.control.tx(run);
  }

  limitsOf(code: string) {
    const byKey = new Map(this.catalog.find((entry) => entry.code === code)?.limits.map((limit) => [limit.key, limit]) ?? []);
    for (const limit of this.meta.limits(code)) byKey.set(limit.key, limit);
    return [...byKey.values()];
  }

  /** The admin role matrix: groups of permissions with their scopes and limits. */
  async grouped(): Promise<Array<{ group: string; items: CatalogItem[] }>> {
    const rows = await this.control.tx((t) => AdminPermission.findAll({ order: [['sortOrder', 'ASC']], transaction: t }));
    const declared = new Map(this.catalog.map((entry) => [entry.code, entry]));
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
