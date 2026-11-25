import { Inject, Injectable } from '@nestjs/common';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../../../options.js';
import type { AdminUser } from '../../../auth/auth-user.js';
import type { OpContext, Step } from '../../../crud/op-context.js';
import { AdminGrantsService } from '../../admin-grants.service.js';
import type { AdminRole } from '../../admin-role.model.js';
import type { CreateAdminRoleDto, UpdateAdminRoleDto } from '../../admin-role.dto.js';

type C = OpContext<AdminRole, object, CreateAdminRoleDto | UpdateAdminRoleDto, AdminUser>;

/**
 * Scopes must be ones the permission offers, and limits ones it declares. With `admin.grantWithinOwn`, an admin gives
 * a role only what they hold themselves (`AdminGrantsService.escalations`).
 */
@Injectable()
export default class CheckGrants implements Step<AdminRole, object, CreateAdminRoleDto | UpdateAdminRoleDto, AdminUser> {
  constructor(
    private readonly grants: AdminGrantsService,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
  ) {}

  async check({ dto, user, issues }: C): Promise<void> {
    if (!dto.permissions) return;
    const problems = this.grants.problems(dto.permissions);
    for (const problem of problems) issues.field('permissions', problem);
    // escalations assumes well-formed grants: only once the catalog checks pass.
    if (problems.length || !this.options.admin?.grantWithinOwn) return;
    for (const problem of await this.grants.escalations(user, dto.permissions)) issues.field('permissions', problem);
  }
}
