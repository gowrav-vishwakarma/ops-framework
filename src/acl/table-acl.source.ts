import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import type { AclScope, AuthUser, Limits } from '../auth/auth-user.js';
import type { AclSource } from '../features.js';
import { NAMES } from '../naming.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { quoteIdent } from '../tenancy/context.js';
import { PARTITION } from '../tenancy/partition.js';
import { TenantDb } from '../tenancy/tenant-db.js';
import type { EffectivePermissions } from './acl.service.js';

/**
 * `features.acl: 'tables'`: role permissions plus per-user grants and denies, from the framework's
 * `roles`, `role_permissions`, `permissions` and `user_permission_overrides` in the tenant schema.
 */
@Injectable()
export class TableAclSource implements AclSource {
  constructor(
    private readonly db: TenantDb,
    @Optional() @Inject(FRAMEWORK_OPTIONS) private readonly options?: Pick<FrameworkOptions, 'acl'>,
  ) {}

  async load(user: AuthUser, t?: Transaction): Promise<EffectivePermissions> {
    const { companyId, id: userId, roleId } = user;
    await this.requireActive(user, t);
    const out: EffectivePermissions = new Map();
    if (roleId) {
      const rows = await this.db.query<{ code: string; scope: AclScope; limits: Limits | null }>(
        `SELECT p.code, rp.scope, rp.limits FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = :roleId AND rp.company_id = :companyId AND r.status = 'active'`,
        { replacements: { roleId, companyId }, transaction: t },
      );
      for (const row of rows) out.set(row.code, { scope: row.scope, limits: row.limits ?? {} });
    }
    const overrides = await this.db.query<{ code: string; effect: 'grant' | 'deny'; scope: AclScope; limits: Limits | null }>(
      `SELECT p.code, o.effect, o.scope, o.limits FROM user_permission_overrides o
       JOIN permissions p ON p.id = o.permission_id
       WHERE o.user_id = :userId AND o.company_id = :companyId`,
      { replacements: { userId, companyId }, transaction: t },
    );
    for (const row of overrides) {
      if (row.effect === 'deny') out.delete(row.code);
      else out.set(row.code, { scope: row.scope, limits: row.limits ?? {} });
    }
    return out;
  }

  /** `acl.userStatusColumn`: refuse a user whose row is not active. */
  private async requireActive({ companyId, id: userId }: AuthUser, t?: Transaction): Promise<void> {
    const column = this.options?.acl?.userStatusColumn;
    if (!column || !userId) return;
    const rows = await this.db.query<{ status: string }>(
      `SELECT ${quoteIdent(column)} AS status FROM ${quoteIdent(NAMES.userTable)} WHERE id = :userId AND ${quoteIdent(PARTITION.column)} = :companyId`,
      { replacements: { userId, companyId }, transaction: t },
    );
    const status = rows[0]?.status;
    if (status !== undefined && status !== 'active') throw new ForbiddenException(`Your account in this company is ${status}`);
  }
}
