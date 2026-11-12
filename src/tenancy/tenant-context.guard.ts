import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_LOGIN_TOKEN, type CtxRequest } from '../auth/decorators.js';
import { TOKEN_VALIDATOR, type TokenValidator } from '../features.js';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { ConnectionRegistry } from './connection-registry.js';
import { setTenant, type TenantRef } from './context.js';
import { PlacementResolver } from './placement.js';
import { SchemaSync } from './schema-sync.js';

/** Optional headers a client may send; they are checked against the token, never used to pick the tenant. */
export const DEFAULT_TENANT_HEADERS: Record<string, 'companyId' | 'tenantKey'> = { 'x-company-id': 'companyId', 'x-tenant-id': 'tenantKey' };

/** What a tenant header must carry for `ref`. */
export function expectedHeader(kind: 'companyId' | 'tenantKey', ref: TenantRef): string {
  return kind === 'tenantKey' && ref.tenantKey ? ref.tenantKey : String(ref.companyId);
}

/**
 * Runs after sign-in is verified and before permissions. From the company token it finds where the
 * tenant's rows live and puts `{ ref, placement, sequelize }` into the request context, so every
 * model call, `c.t` and `TenantDb` after it reach the right database and schema. The token is the
 * only source of the tenant: a header that disagrees with it is refused, not obeyed.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly placements: PlacementResolver,
    private readonly registry: ConnectionRegistry,
    private readonly schemas: SchemaSync,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    @Optional() @Inject(TOKEN_VALIDATOR) private readonly validator?: TokenValidator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & CtxRequest>();
    if (!request.user) return true;
    // Login-token routes (company list, switch company) work on the control plane only.
    if (this.reflector.getAllAndOverride<boolean>(IS_LOGIN_TOKEN, [context.getHandler(), context.getClass()])) return true;

    const ref = this.options.tenancy.resolve?.(request.user) ?? { companyId: request.user.companyId, tenantKey: request.user.tenantKey ?? null };
    for (const [header, kind] of Object.entries(this.options.tenancy.headers ?? DEFAULT_TENANT_HEADERS)) {
      const sent = request.headers[header.toLowerCase()];
      if (sent === undefined || sent === '') continue;
      if (String(Array.isArray(sent) ? sent[0] : sent) !== expectedHeader(kind, ref)) {
        throw new ForbiddenException('Header does not match the signed-in company');
      }
    }
    const placement = await this.placements.resolve(ref);
    if (this.options.auth.epoch === 'required' && request.user.epoch !== placement.epoch) throw new UnauthorizedException('This company was moved. Sign in again.');
    const sequelize = await this.registry.get(placement.dbKey);
    await this.schemas.checkParity(sequelize, placement.dbKey, placement.schema);
    setTenant({ ref, placement, sequelize });
    if (this.validator) {
      const extra = await this.validator.validate(request.claims ?? {}, request.user, request);
      if (extra) request.user = { ...request.user, ...extra };
    }
    return true;
  }
}
