import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';
import type { AdminTokenValidator } from '../features.js';
import type { FrameworkOptions } from '../options.js';
import type { AdminUser, AuthUser } from './auth-user.js';
import { AdminRoutes } from './decorators.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const SECRET = 'admin-token-spec';
const jwt = new JwtService({ secret: SECRET });
/** A project whose admin tokens are named by their own claims (Ankpal: `role: 'admin'` with an `employeeId`). */
const options = {
  auth: {
    jwtSecret: SECRET,
    userClaims: (c: Record<string, unknown>) => ({ id: 1, companyId: Number(c.companyId) }) as unknown as AuthUser,
    tokenKind: (c: Record<string, unknown>) => (c.role === 'admin' && typeof c.employeeId === 'number' ? 'admin' : c.companyId != null ? 'access' : 'login'),
  },
  admin: { catalog: [], userClaims: (c: Record<string, unknown>) => ({ id: Number(c.employeeId), name: 'a', kind: 'admin', roleId: null, aclVersion: 0, extra: {} }) as unknown as AdminUser },
} as unknown as FrameworkOptions;

class CompanyRoutes {
  list() {}
}
@AdminRoutes()
class AdminSide {
  list() {}
}

function ctx(type: typeof CompanyRoutes | typeof AdminSide, token: string) {
  const request: Record<string, any> = { headers: { authorization: `Bearer ${token}` } };
  const context = { getHandler: () => type.prototype.list, getClass: () => type, switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { context, request };
}
const guard = (validator?: AdminTokenValidator) => new JwtAuthGuard(new Reflector(), jwt, options, undefined, validator);

describe('admin tokens', () => {
  it('only on admin routes; a company token is refused there', async () => {
    const admin = await jwt.signAsync({ sub: 5, employeeId: 5, role: 'admin', email: 'a@x' });
    const company = await jwt.signAsync({ companyId: 7, role: 'owner' });
    expect(await guard().canActivate(ctx(AdminSide, admin).context)).toBe(true);
    await expect(guard().canActivate(ctx(CompanyRoutes, admin).context)).rejects.toThrow('An admin token cannot open company data');
    await expect(guard().canActivate(ctx(AdminSide, company).context)).rejects.toThrow('Admin sign-in required');
  });

  it("the project's validator runs for every admin request: refuses a revoked session, adds to the admin", async () => {
    const validator: AdminTokenValidator = {
      validate: (claims) => (claims.jti === 'revoked' ? Promise.reject(new UnauthorizedException('Session revoked')) : Promise.resolve({ extra: { checked: true } })),
    };
    const ok = ctx(AdminSide, await jwt.signAsync({ employeeId: 5, role: 'admin' }, { jwtid: 'current' }));
    expect(await guard(validator).canActivate(ok.context)).toBe(true);
    expect(ok.request.admin).toMatchObject({ id: 5, extra: { checked: true } });
    const revoked = await jwt.signAsync({ employeeId: 5, role: 'admin' }, { jwtid: 'revoked' });
    await expect(guard(validator).canActivate(ctx(AdminSide, revoked).context)).rejects.toThrow('Session revoked');
  });
});
