import { ForbiddenException, Inject, Injectable, Optional, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC, REQUIRED_PERMISSION, type RequiredPermission, type CtxRequest } from '../auth/decorators.js';
import { AdminAclService } from '../admin/admin-acl.service.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { AclService } from './acl.service.js';
import { permissionCode } from './permission-code.js';

/** Enforces `@RequirePermission` and records the granted scope and limits for the service. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    @Optional() private readonly acl?: AclService,
    @Optional() private readonly adminAcl?: AdminAclService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const required = this.reflector.getAllAndOverride<RequiredPermission | undefined>(REQUIRED_PERMISSION, targets);
    if (!required) return true;
    const request = context.switchToHttp().getRequest<CtxRequest>();
    const code = permissionCode(request.admin ? undefined : this.options, required.resource, required.action);
    const source = request.admin ? this.adminAcl : this.acl;
    if ((request.admin || request.user) && !source) throw new Error(`@RequirePermission(${code}) needs ${request.admin ? 'features.admin' : 'features.acl'} in FrameworkModule.forRootAsync`);
    const granted = request.admin ? await this.adminAcl!.effective(request.admin) : request.user ? await this.acl!.effective(request.user) : null;
    if (!granted) return false;
    const grant = granted.get(code);
    if (!grant) throw new ForbiddenException(`You do not have permission: ${code}`);
    request.aclScope = grant.scope;
    request.aclLimits = grant.limits;
    if (grant.params) request.aclScopeParams = grant.params;
    return true;
  }
}
