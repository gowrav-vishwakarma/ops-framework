import { Injectable } from '@nestjs/common';
import type { AdminUser } from '../../../auth/auth-user.js';
import type { OpContext, Step } from '../../../crud/op-context.js';
import { AdminGrantsService } from '../../admin-grants.service.js';
import type { AdminRole } from '../../admin-role.model.js';
import type { CreateAdminRoleDto, UpdateAdminRoleDto } from '../../admin-role.dto.js';

type C = OpContext<AdminRole, object, CreateAdminRoleDto | UpdateAdminRoleDto, AdminUser>;

/** Scopes must be ones the permission offers, and limits ones it declares. */
@Injectable()
export default class CheckGrants implements Step<AdminRole, object, CreateAdminRoleDto | UpdateAdminRoleDto, AdminUser> {
  constructor(private readonly grants: AdminGrantsService) {}

  async check({ dto, issues }: C): Promise<void> {
    if (!dto.permissions) return;
    for (const problem of this.grants.problems(dto.permissions)) issues.field('permissions', problem);
  }
}
