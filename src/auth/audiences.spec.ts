import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import type { FrameworkOptions } from '../options.js';
import type { AuthUser } from './auth-user.js';
import { Audience } from './decorators.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const SECRET = 'audience-spec-secret';
const jwt = new JwtService({ secret: SECRET });
const user = (over: Partial<AuthUser>): AuthUser => ({ id: 1, platformUserId: 1, companyId: 7, epoch: 0, branchId: 1, branchIds: [], roleId: null, aclVersion: 0, partyId: null, name: 'u', ...over });
const options = {
  auth: {
    jwtSecret: SECRET,
    userClaims: (c: Record<string, unknown>) => user({ companyId: Number(c.companyId) }),
    audiences: { orderPanel: { matches: (c: Record<string, unknown>) => c.role === '_orderPanel', userClaims: (c: Record<string, unknown>) => user({ companyId: Number(c.companyId), branchId: null, partyId: Number(c.accountId) }) } },
  },
} as unknown as FrameworkOptions;

class Routes {
  company() {}
  @Audience('orderPanel') panel() {}
  @Audience('orderPanel', 'company') both() {}
  @Audience('apiKey') integration() {}
}

function ctx(handler: keyof Routes, authorization: string): { context: ExecutionContext; request: Record<string, any> } {
  const request: Record<string, any> = { headers: { authorization } };
  const context = { getHandler: () => Routes.prototype[handler], getClass: () => Routes, switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { context, request };
}

const guard = (apiKeys?: { validate: (key: string) => Promise<AuthUser> }) => new JwtAuthGuard(new Reflector(), jwt, options, apiKeys as never);
const companyToken = () => jwt.signAsync({ companyId: 7, typ: 'access' });
const panelToken = () => jwt.signAsync({ companyId: 7, role: '_orderPanel', accountId: 42 });

describe('audiences: portals and API keys only where a route serves them', () => {
  it('a company token opens company routes, not a portal-only route; a route naming both takes it', async () => {
    expect(await guard().canActivate(ctx('company', `Bearer ${await companyToken()}`).context)).toBe(true);
    await expect(guard().canActivate(ctx('panel', `Bearer ${await companyToken()}`).context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await guard().canActivate(ctx('both', `Bearer ${await companyToken()}`).context)).toBe(true);
  });

  it("a portal token is refused on company routes; on its own routes it signs in as its party's user", async () => {
    await expect(guard().canActivate(ctx('company', `Bearer ${await panelToken()}`).context)).rejects.toThrow('This sign-in cannot open this page');
    const { context, request } = ctx('panel', `Bearer ${await panelToken()}`);
    expect(await guard().canActivate(context)).toBe(true);
    expect(request.audience).toBe('orderPanel');
    expect(request.user).toMatchObject({ companyId: 7, partyId: 42, branchId: null });
  });

  it('an API key opens only routes that take one, through the project validator', async () => {
    const keys = { validate: async (key: string) => (key === 'good-key' ? user({ id: 9, companyId: 7 }) : Promise.reject(new UnauthorizedException('Unknown key'))) };
    const { context, request } = ctx('integration', 'Bearer good-key');
    expect(await guard(keys).canActivate(context)).toBe(true);
    expect(request).toMatchObject({ audience: 'apiKey', user: { id: 9, companyId: 7 } });
    await expect(guard(keys).canActivate(ctx('integration', 'Bearer bad-key').context)).rejects.toThrow('Unknown key');
    await expect(guard(keys).canActivate(ctx('company', 'Bearer good-key').context)).rejects.toThrow('Session expired');
    await expect(guard().canActivate(ctx('integration', 'Bearer good-key').context)).rejects.toThrow('Session expired');
  });
});
