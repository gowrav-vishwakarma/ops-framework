import { Inject, Injectable } from '@nestjs/common';
import { Op, type Transaction } from 'sequelize';
import { fieldErrors } from '../errors.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { AdminAclService, AdminPermissionMeta } from './admin-acl.service.js';
import { AdminPermission } from './admin-permission.model.js';
import { AdminRolePermission } from './admin-role-permission.model.js';
import type { AdminRole } from './admin-role.model.js';
import type { AdminGrantDto } from './admin-role.dto.js';

/** Validates and writes an admin role's grants. */
@Injectable()
export class AdminGrantsService {
  constructor(
    private readonly meta: AdminPermissionMeta,
    private readonly acl: AdminAclService,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
  ) {}

  /** Unknown permissions, scopes the permission does not offer, undeclared or negative limits. */
  problems(grants: readonly AdminGrantDto[]): string[] {
    const catalog = new Map((this.options.admin?.catalog ?? []).map((entry) => [entry.code, entry]));
    const out: string[] = [];
    for (const grant of grants) {
      const entry = catalog.get(grant.code);
      if (!entry) {
        out.push(`Unknown permission ${grant.code}`);
        continue;
      }
      if (!entry.scopes.includes(grant.scope)) out.push(`${grant.code}: scope "${grant.scope}" is not offered (${entry.scopes.join(', ')})`);
      const allowed = new Set([...entry.limits, ...this.meta.limits(grant.code)].map((limit) => limit.key));
      for (const [key, value] of Object.entries(grant.limits ?? {})) {
        if (!allowed.has(key)) out.push(`${grant.code}: "${key}" is not a limit of this permission`);
        else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) out.push(`${grant.code}: limit "${key}" must be a number from 0`);
      }
    }
    return out;
  }

  /** Replaces the role's grants and bumps its ACL version. */
  async replace(role: AdminRole, grants: readonly AdminGrantDto[], t: Transaction): Promise<void> {
    const problems = this.problems(grants);
    if (problems.length) throw fieldErrors({ permissions: problems });
    const rows = await AdminPermission.findAll({ where: { code: { [Op.in]: grants.map((grant) => grant.code) } }, attributes: ['id', 'code'], transaction: t });
    const ids = new Map(rows.map((row) => [row.code, row.id as number]));
    await AdminRolePermission.destroy({ where: { roleId: role.id }, transaction: t });
    await AdminRolePermission.bulkCreate(
      grants.map((grant) => ({ roleId: role.id, permissionId: ids.get(grant.code), scope: grant.scope, limits: grant.limits ?? {} })) as never[],
      { transaction: t },
    );
    await role.increment('aclVersion', { transaction: t });
    t.afterCommit(() => this.acl.forget());
  }
}
