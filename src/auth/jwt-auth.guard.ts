import { Inject, Injectable, Optional, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { FRAMEWORK_OPTIONS, type FrameworkOptions } from '../options.js';
import { PARTITION } from '../tenancy/partition.js';
import { API_KEY_VALIDATOR, type ApiKeyValidator } from '../features.js';
import { AUDIENCES, IS_ADMIN, IS_LOGIN_TOKEN, IS_PUBLIC, type CtxRequest } from './decorators.js';

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
 * `@LoginToken()` routes; an admin token only on `@AdminRoutes()`. A portal token (`auth.audiences`) and an
 * integration's API key (`features.apiKeys`) only on routes that serve them (`@Audience(...)`); such a route
 * refuses the company's tokens unless it names `'company'` too.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(FRAMEWORK_OPTIONS) private readonly options: FrameworkOptions,
    @Optional() @Inject(API_KEY_VALIDATOR) private readonly apiKeys?: ApiKeyValidator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const request = context.switchToHttp().getRequest<Request & CtxRequest>();
    const [type, token] = (request.headers.authorization ?? '').split(' ');
    if (type !== 'Bearer' || !token) throw new UnauthorizedException('Sign in required');
    const served = this.reflector.getAllAndOverride<string[] | undefined>(AUDIENCES, targets);
    let claims: Record<string, unknown>;
    try {
      const { issuer, audience } = this.options.auth;
      claims = await this.jwt.verifyAsync<Record<string, unknown>>(token, { ...(issuer ? { issuer } : {}), ...(audience ? { audience } : {}) });
    } catch {
      // Not a token we signed: an integration's API key, where the route takes one.
      if (served?.includes('apiKey') && this.apiKeys) {
        request.user = await this.apiKeys.validate(token, request);
        request.audience = 'apiKey';
        return true;
      }
      throw new UnauthorizedException('Session expired');
    }
    // A portal's token (a party's panel, a salesman's app): only where the route serves that audience.
    for (const [name, def] of Object.entries(this.options.auth.audiences ?? {})) {
      if (!def.matches(claims)) continue;
      if (!served?.includes(name)) throw new UnauthorizedException('This sign-in cannot open this page');
      request.user = def.userClaims(claims);
      request.claims = claims;
      request.audience = name;
      return true;
    }
    const kind = (this.options.auth.tokenKind ?? defaultTokenKind)(claims);
    if (kind === 'access' && served && !served.includes('company')) throw new UnauthorizedException('This page is not for company users');
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
