import { Body, Controller, Get, Module, Param, ParseIntPipe, Put } from '@nestjs/common';
import type { AdminUser, ReqCtx } from '../auth/auth-user.js';
import { AdminRoutes, Ctx, RequirePermission } from '../auth/decorators.js';
import { crudController } from '../crud/crud-controller.js';
import { fieldError } from '../errors.js';
import { ControlPlane } from '../tenancy/tenant-db.js';
import { AdminCatalogService } from './admin-catalog.service.js';
import { AdminGrantsService } from './admin-grants.service.js';
import { CreateAdminRoleDto, ReplaceAdminGrantsDto, UpdateAdminRoleDto } from './admin-role.dto.js';
import { AdminRolesService } from './admin-roles.service.js';

/** The admin permission catalog, grouped for the role matrix. */
@AdminRoutes()
@Controller('admin/permissions')
export class AdminPermissionsController {
  constructor(private readonly catalog: AdminCatalogService) {}

  @Get()
  @RequirePermission('admin_role', 'view')
  list() {
    return this.catalog.grouped();
  }
}

@Controller('admin/roles')
export class AdminRolesController extends crudController({
  resource: 'admin_role',
  service: AdminRolesService,
  create: CreateAdminRoleDto,
  update: UpdateAdminRoleDto,
  plane: 'control',
}) {
  constructor(
    private readonly grants: AdminGrantsService,
    private readonly control: ControlPlane,
  ) {
    super();
  }

  @Put(':id/permissions')
  @RequirePermission('admin_role', 'update')
  async replacePermissions(@Ctx() ctx: ReqCtx<AdminUser>, @Param('id', ParseIntPipe) id: number, @Body() dto: ReplaceAdminGrantsDto) {
    const service = this.service as AdminRolesService;
    await this.control.tx(async (t) => {
      const role = await service.findOne(ctx, id, t, true);
      if (role.isSystem) throw fieldError('permissions', 'System role always has every permission');
      await this.grants.replace(role, dto.items, t);
    });
    return service.get(ctx, id);
  }
}

/** Resource of the admin role screens; add it to `FrameworkOptions.admin.catalog`. */
export const ADMIN_ROLE_RESOURCE = { resource: 'admin_role', label: 'Admin roles', actions: ['view', 'create', 'update', 'delete', 'activate', 'deactivate'], scopes: ['all'] } as const;

/**
 * Admin roles and their permission matrix (`/admin/roles`, `/admin/permissions`). Import it in the
 * deployment that runs the platform service.
 */
@Module({
  controllers: [AdminPermissionsController, AdminRolesController],
  providers: [AdminRolesService, AdminGrantsService],
  exports: [AdminRolesService, AdminGrantsService],
})
export class AdminAclModule {}
