import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../auth/auth-user.js';
import { AclService } from './acl.service.js';
import { TableAclSource } from './table-acl.source.js';

const user = (companyId: number, id: number): AuthUser => ({ id, platformUserId: id, companyId, epoch: 1, branchId: null, branchIds: [], roleId: 3, aclVersion: 0, partyId: null, name: 'T' });

function service() {
  const loads: Array<{ companyId: number; userId: number }> = [];
  const db = {
    query: async (sql: string, options: { replacements: { companyId: number; userId?: number; roleId?: number } }) => {
      if (sql.includes('role_permissions')) loads.push({ companyId: options.replacements.companyId, userId: 0 });
      return [];
    },
  };
  return { acl: new AclService(new TableAclSource(db as never)), loads };
}

describe('ACL cache', () => {
  it('is keyed by company and user: the same user id in two companies is two entries', async () => {
    const { acl, loads } = service();
    await acl.effective(user(1, 5));
    await acl.effective(user(2, 5));
    await acl.effective(user(1, 5));
    expect(loads.map((l) => l.companyId)).toEqual([1, 2]);
  });

  it('forgetUser drops one user of one company; forgetCompany drops the company', async () => {
    const { acl, loads } = service();
    await acl.effective(user(1, 5));
    await acl.effective(user(2, 5));
    acl.forgetUser(1, 5);
    await acl.effective(user(1, 5));
    await acl.effective(user(2, 5));
    expect(loads.map((l) => l.companyId)).toEqual([1, 2, 1]);
    acl.forgetCompany(2);
    await acl.effective(user(2, 5));
    expect(loads.map((l) => l.companyId)).toEqual([1, 2, 1, 2]);
  });
});
