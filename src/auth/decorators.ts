import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { AclScope, Actor, AdminUser, AuthUser, Limits, ReqCtx } from './auth-user.js';

export const IS_PUBLIC = 'fw:public';
export const IS_LOGIN_TOKEN = 'fw:login-token';
export const REQUIRED_PERMISSION = 'fw:permission';
export const IS_ADMIN = 'fw:admin';

export interface RequiredPermission {
  resource: string;
  action: string;
}

/** No access token needed. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * The route takes the short-lived login token (and the company token): the company list and
 * switch-company. Every other route refuses a login token.
 */
export const LoginToken = () => SetMetadata(IS_LOGIN_TOKEN, true);

/**
 * The controller is part of the admin side (control plane): only admin tokens (`typ: 'admin'`) are
 * accepted, no tenant context is set, and permissions are the admin's. A company token is refused.
 */
export const AdminRoutes = () => SetMetadata(IS_ADMIN, true);

/** The caller needs `resource.action`. The guard puts the granted scope and limits on the request. */
export const RequirePermission = (resource: string, action: string) =>
  SetMetadata(REQUIRED_PERMISSION, { resource, action } satisfies RequiredPermission);

export interface CtxRequest {
  user?: AuthUser;
  /** The signed-in admin, on `@AdminRoutes()` controllers. */
  admin?: AdminUser;
  /** Verified claims of a login token (only on `@LoginToken()` routes). */
  loginClaims?: { sub: number; typ: 'login' } & Record<string, unknown>;
  aclScope?: AclScope;
  aclLimits?: Limits;
  aclScopeParams?: Record<string, unknown>;
  /** Verified claims of a company token, for the project's `TokenValidator`. */
  claims?: Record<string, unknown>;
}

/** `{ user, scope, limits }` for the current request: the company user, or the admin on admin routes. */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): ReqCtx<Actor> => {
  const request = context.switchToHttp().getRequest<CtxRequest>();
  const user = request.admin ?? request.user;
  if (!user) throw new Error('Ctx used on a public route');
  return { user, scope: request.aclScope ?? 'all', limits: request.aclLimits ?? {}, ...(request.aclScopeParams ? { scopeParams: request.aclScopeParams } : {}) };
});
