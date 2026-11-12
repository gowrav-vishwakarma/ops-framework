import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { PARTITION } from '../tenancy/partition.js';
import { IS_ADMIN, IS_LOGIN_TOKEN, IS_PUBLIC, type CtxRequest } from './decorators.js';

export type TokenKind = 'access' | 'login' | 'admin' | null;

/** Default `auth.tokenKind`: the `typ` claim, else a company token when it carries the partition field. */
export function defaultTokenKind(claims: Record<string, unknown>): TokenKind {
  if (typeof claims.typ === 'string') return claims.typ === 'access' || claims.typ === 'login' || claims.typ === 'admin' ? claims.typ : null;
  return claims[PARTITION.field] != null ? 'access' : 'login';
}

/**
 * Verifies the bearer token, without a database hit (a project's `TokenValidator` runs once the
 * tenant context is set, in `TenantContextGuard`). A company
 * token (`access`) works everywhere; a login token (issued before a company is chosen) only on
 * `@LoginToken()` routes; an admin token only on `@AdminRoutes()`.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const request = context.switchToHttp().getRequest<Request & CtxRequest>();
    const [type, token] = (request.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Sign in required');
    let claims: Record<string, unknown>;
    try {
      const { issuer, audience } = this.options.auth;
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, { ...(issuer ? { issuer } : {}), ...(audience ? { audience } : {}) });
    } catch {
      throw new UnauthorizedException('Session expired');
    }
    const kind = (this.options.auth.tokenKind ?? defaultTokenKind)(claims);
    const adminRoute = this.reflector.getAllAndOverride<boolean>(IS_ADMIN, targets) === true;
    if (adminRoute || kind === 'admin') {
      if (!adminRoute) throw new UnauthorizedException('An admin token cannot open company data');
      if (kind !== 'admin' || !this.options.admin) throw new UnauthorizedException('Admin sign-in required');
      request.admin = this.options.admin.userClaims(claims);
      return true;
    }
    if (kind === 'access') {
      request.user = this.options.auth.userClaims(claims);
      request.claims = claims;
      return true;
    }
    if (kind === 'login' && this.reflector.getAllAndOverride<boolean>(IS_LOGIN_TOKEN, targets)) {
      request.loginClaims = claims as CtxRequest['loginClaims'];
      return true;
    }
    throw new UnauthorizedException(kind === 'login' ? 'Choose a company first' : 'Session expired');
  }
}
