import { Injectable } from '@nestjs/common';
import type { Includeable, Order } from 'sequelize';
import type { AdminUser, ReqCtx } from '../auth/auth-user.js';
import { ControlCrudService } from '../crud/control-crud.service.js';
import { opsFolder } from '../crud/ops-loader.js';
import type { Attrs } from '../crud/op-context.js';
import { statusActions } from '../crud/status-actions.js';
import { AdminPermission } from './admin-permission.model.js';
import { AdminRolePermission } from './admin-role-permission.model.js';
import { AdminRole } from './admin-role.model.js';
import type { CreateAdminRoleDto, UpdateAdminRoleDto } from './admin-role.dto.js';

/** Admin roles: configuration only. Checks and effects are in `role-ops/`. */
@Injectable()
export class AdminRolesService extends ControlCrudService<AdminRole, CreateAdminRoleDto, UpdateAdminRoleDto> {
  readonly resource = 'admin_role';
  protected readonly model = AdminRole;
  protected readonly opsDir = opsFolder(import.meta.url, 'role-ops');
  protected readonly label = 'Admin role';
  protected readonly searchFields = ['name', 'code'];
  protected readonly sortable = ['name', 'code', 'description', 'status', 'createdAt'];
  protected readonly defaultOrder: Order = [['name', 'ASC']];
  protected readonly actions = statusActions<AdminRole, AdminUser>({ noun: 'role' });

  protected detailInclude(): Includeable[] {
    return [{ model: AdminRolePermission, include: [{ model: AdminPermission, attributes: ['code'] }] }];
  }

  protected async toCreate(_ctx: ReqCtx<AdminUser>, dto: CreateAdminRoleDto): Promise<Attrs> {
    const { permissions: _permissions, ...values } = dto;
    return { ...values, code: values.code.toUpperCase() };
  }

  protected async toUpdate(_ctx: ReqCtx<AdminUser>, dto: UpdateAdminRoleDto): Promise<Attrs> {
    const { permissions: _permissions, ...values } = dto;
    if (values.code) values.code = values.code.toUpperCase();
    return values;
  }
}
