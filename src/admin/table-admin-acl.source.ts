import { Injectable } from '@nestjs/common';
import type { EffectivePermissions } from '../acl/acl.service.js';
import type { AclScope, AdminUser, Limits } from '../auth/auth-user.js';
import type { AdminAclSource } from '../features.js';
import { ControlPlane } from '../tenancy/tenant-db.js';

/** `features.admin: 'tables'`: an admin's permissions are its role's grants in the framework's admin tables. */
@Injectable()
export class TableAdminAclSource implements AdminAclSource {
  constructor(private readonly control: ControlPlane) {}

  async load(admin: AdminUser): Promise<EffectivePermissions> {
    const out: EffectivePermissions = new Map();
    if (!admin.roleId) return out;
    const rows = await this.control.query<{ code: string; scope: AclScope; limits: Limits | null }>(
      `SELECT p.code, rp.scope, rp.limits FROM admin_role_permissions rp
         JOIN admin_roles r ON r.id = rp.role_id
         JOIN admin_permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = :roleId AND r.status = 'active'`,
      { replacements: { roleId: admin.roleId } },
    );
    for (const row of rows) out.set(row.code, { scope: row.scope, limits: row.limits ?? {} });
    return out;
  }
}
