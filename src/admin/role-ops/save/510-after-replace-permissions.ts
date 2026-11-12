import { Injectable } from '@nestjs/common';
import type { AdminUser } from '../../../auth/auth-user.js';
import type { OpContext, Step } from '../../../crud/op-context.js';
import { AdminGrantsService } from '../../admin-grants.service.js';
import type { AdminRole } from '../../admin-role.model.js';
import type { CreateAdminRoleDto, UpdateAdminRoleDto } from '../../admin-role.dto.js';

type C = OpContext<AdminRole, object, CreateAdminRoleDto | UpdateAdminRoleDto, AdminUser>;

/** Saves the permission matrix sent with the role, when one was sent. */
@Injectable()
export default class ReplacePermissions implements Step<AdminRole, object, CreateAdminRoleDto | UpdateAdminRoleDto, AdminUser> {
  constructor(private readonly grants: AdminGrantsService) {}

  async after({ row, dto, t }: C): Promise<void> {
    if (dto.permissions) await this.grants.replace(row, dto.permissions, t);
  }
}
