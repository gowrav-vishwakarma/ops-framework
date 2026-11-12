import { Op } from 'sequelize';
import { describe, expect, it } from 'vitest';
import type { ReqCtx } from '../auth/auth-user.js';
import { allScope, branchScope, ownScope, resolveScopes, BUILT_IN_SCOPES, type ScopeDef } from './scopes.js';

const ctx = (user: Partial<ReqCtx['user']> = {}): ReqCtx => ({
  scope: 'all',
  limits: {},
  user: { id: 7, platformUserId: 1, companyId: 1, epoch: 1, branchId: 2, branchIds: [2, 3], roleId: 1, aclVersion: 0, partyId: null, name: 'T', ...user },
});
const model = (attrs: string[]) => ({ getAttributes: () => Object.fromEntries(attrs.map((a) => [a, {}])) }) as never;
const row = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as never;

describe('scopes', () => {
  it('all adds no condition', () => {
    expect(allScope.where(ctx(), model([]), { partyFields: [] })).toBeNull();
  });

  it('branch limits to the user\'s branches, only on models that have a branch', () => {
    expect(branchScope.where(ctx(), model(['branchId']), { partyFields: [] })).toEqual({ branchId: { [Op.in]: [2, 3] } });
    expect(branchScope.where(ctx(), model(['name']), { partyFields: [] })).toBeNull();
    expect(branchScope.allows?.(ctx(), row({ branchId: 3 }), { partyFields: [] })).toBe(true);
    expect(branchScope.allows?.(ctx(), row({ branchId: 9 }), { partyFields: [] })).toBe(false);
  });

  it('own is the creator, widened to the party for portal users', () => {
    const env = { partyFields: ['driverId'] };
    expect(ownScope.allows?.(ctx(), row({ createdById: 7 }), env)).toBe(true);
    expect(ownScope.allows?.(ctx(), row({ createdById: 8, driverId: 5 }), env)).toBe(false);
    expect(ownScope.allows?.(ctx({ partyId: 5 }), row({ createdById: 8, driverId: 5 }), env)).toBe(true);
    expect(ownScope.where(ctx({ partyId: 5 }), model([]), env)).toEqual({ [Op.or]: [{ createdById: 7 }, { driverId: 5 }] });
  });

  it('a resource can offer registered scopes and its own, and an unknown one is an error', () => {
    const local: ScopeDef = { id: 'my-team', label: 'My team', where: () => ({ teamId: 1 }) };
    const registered: ScopeDef = { id: 'active-only', label: 'Active', where: () => ({ status: 'active' }) };
    const resolved = resolveScopes(['all', 'active-only', local as never], [...BUILT_IN_SCOPES, registered]);
    expect([...resolved.keys()]).toEqual(['all', 'active-only', 'my-team']);
    expect(() => resolveScopes(['nonsense'], BUILT_IN_SCOPES)).toThrow(/Unknown scope "nonsense"/);
  });
});
