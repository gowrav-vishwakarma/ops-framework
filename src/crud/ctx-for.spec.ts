import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Grant } from '../acl/acl.service.js';
import { withGrant, type ReqCtx } from '../auth/auth-user.js';
import { CrudService } from './crud.service.js';

/**
 * A step of one resource calling another resource's action (`perform`) runs with the caller's own grant of THAT action
 * (`ctxFor`), not the outer operation's scope: a scope id such as `branch` reads a different column on each resource.
 */
const outer: ReqCtx = { scope: 'branch', limits: { amount: 10 }, scopeParams: { branchIds: [3] }, user: { id: 1, companyId: 1, branchId: 3, branchIds: [3], roleId: 1, partyId: null, name: 'Clerk' } } as never;

describe('withGrant: the context a grant gives', () => {
  it('takes the grant\'s scope, limits and scope data, and drops the outer scope data when the grant has none', () => {
    expect(withGrant(outer, { scope: 'all', limits: {} })).toEqual({ ...outer, scope: 'all', limits: {}, scopeParams: undefined });
    expect(withGrant(outer, { scope: 'branch', limits: {}, params: { branchIds: [7] } }).scopeParams).toEqual({ branchIds: [7] });
  });
});

describe('ctxFor: the caller\'s context for one of this resource\'s operations', () => {
  /** A resource `lr` with an action `track` (permission `lr.track`) and a renamed one (`reopen` held as `lr.manage`). */
  const service = (grants: Record<string, Grant>) => {
    const svc = Object.create(CrudService.prototype) as CrudService<never, never> & Record<string, unknown>;
    Object.assign(svc, {
      actionList: [{ name: 'track', label: 'Track' }, { name: 'reopen', label: 'Reopen', permission: 'manage' }],
      actionPermission: (action: { name: string; permission?: string }) => `lr.${action.permission ?? action.name}`,
      permission: (op: string) => `lr.${op}`,
      grantOf: async (_ctx: ReqCtx, code: string) => {
        const grant = grants[code];
        if (!grant) throw new ForbiddenException(`You don't have permission to ${code}`);
        return grant;
      },
    });
    return svc;
  };

  it('an action: the caller\'s own grant of its permission, not the outer scope', async () => {
    const lrs = service({ 'lr.track': { scope: 'all', limits: {} }, 'lr.manage': { scope: 'own', limits: {} } });
    expect(await lrs.ctxFor(outer as never, 'track')).toMatchObject({ scope: 'all', limits: {}, scopeParams: undefined, user: outer.user });
    expect((await lrs.ctxFor(outer as never, 'reopen')).scope).toBe('own');
  });

  it('a built-in operation (update, delete) by its permission', async () => {
    const lrs = service({ 'lr.update': { scope: 'branch', limits: {}, params: { branchIds: [9] } } });
    expect(await lrs.ctxFor(outer as never, 'update')).toMatchObject({ scope: 'branch', scopeParams: { branchIds: [9] } });
  });

  it('403 when the caller does not hold it', async () => {
    await expect(service({}).ctxFor(outer as never, 'track')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
