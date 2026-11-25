import { describe, expect, it, vi } from 'vitest';
import type { EffectivePermissions } from '../acl/acl.service.js';
import type { AdminUser } from '../auth/auth-user.js';
import type { Grant } from '../acl/acl.service.js';
import type { FrameworkOptions } from '../options.js';
import { AdminGrantsService } from './admin-grants.service.js';
import CheckGrants from './role-ops/save/030-check-grants.js';

const admin: AdminUser = { id: 4, name: 'A', roleId: 1, aclVersion: 1, kind: 'admin', extra: {} };
const catalog = [
  { code: 'companies.view', scopes: ['all', 'own'], limits: [] },
  { code: 'refunds.approve', scopes: ['all'], limits: [{ key: 'amount' }] },
  { code: 'admins.manage', scopes: ['all'], limits: [] },
];

function setup(held: EffectivePermissions, admin_: Partial<NonNullable<FrameworkOptions['admin']>> = {}) {
  const options = { admin: { catalog, userClaims: () => admin, ...admin_ } } as unknown as FrameworkOptions;
  const meta = { limits: () => [] };
  const acl = { effective: vi.fn(async () => held) };
  const grants = new AdminGrantsService(meta as never, acl as never, options);
  return { grants, options };
}

const held: EffectivePermissions = new Map<string, Grant>([
  ['companies.view', { scope: 'own', limits: {} }],
  ['refunds.approve', { scope: 'all', limits: { amount: 1000 } }],
]);
/** What the system role (SUPER_ADMIN) holds: every permission, scope `all`, no limits. */
const superAdmin: EffectivePermissions = new Map(catalog.map((entry): [string, Grant] => [entry.code, { scope: 'all', limits: {} }]));

describe('AdminGrantsService.escalations', () => {
  it('is empty when the granter holds everything granted', async () => {
    const { grants } = setup(held);
    expect(await grants.escalations(admin, [{ code: 'companies.view', scope: 'own' }, { code: 'refunds.approve', scope: 'all', limits: { amount: 500 } }])).toEqual([]);
  });

  it('a granter holding every permission with scope all and no limits (system role) may grant anything', async () => {
    const { grants } = setup(superAdmin);
    expect(
      await grants.escalations(admin, [
        { code: 'admins.manage', scope: 'all' },
        { code: 'companies.view', scope: 'all' },
        { code: 'refunds.approve', scope: 'all' },
      ]),
    ).toEqual([]);
  });

  it('names a permission not held, a wider scope and a limit above or missing', async () => {
    const { grants } = setup(held);
    expect(
      await grants.escalations(admin, [
        { code: 'admins.manage', scope: 'all' },
        { code: 'companies.view', scope: 'all' },
        { code: 'refunds.approve', scope: 'all', limits: { amount: 5000 } },
        { code: 'refunds.approve', scope: 'all' },
      ]),
    ).toEqual([
      'admins.manage: you do not hold it',
      'companies.view: scope "all" is wider than yours ("own")',
      'refunds.approve: limit "amount" above yours (1000)',
      'refunds.approve: limit "amount" above yours (1000)',
    ]);
  });
});

describe('admin role save: admin.grantWithinOwn', () => {
  const run = async (on: boolean) => {
    const { grants, options } = setup(held, on ? { grantWithinOwn: true } : {});
    const fields: string[] = [];
    const issues = { field: (_name: string, message: string) => fields.push(message) };
    await new CheckGrants(grants, options).check({ dto: { permissions: [{ code: 'admins.manage', scope: 'all' }] }, user: admin, issues } as never);
    return fields;
  };

  it('on: refuses grants beyond the editor', async () => {
    expect(await run(true)).toEqual(['admins.manage: you do not hold it']);
  });

  it('on: malformed grants are reported by the catalog checks only, escalations are not computed', async () => {
    const { grants, options } = setup(held, { grantWithinOwn: true });
    const escalations = vi.spyOn(grants, 'escalations');
    const fields: string[] = [];
    const issues = { field: (_name: string, message: string) => fields.push(message) };
    await new CheckGrants(grants, options).check({ dto: { permissions: [{ code: 'nope', scope: 'all' }] }, user: admin, issues } as never);
    expect(fields).toEqual(['Unknown permission nope']);
    expect(escalations).not.toHaveBeenCalled();
  });

  it('off (default): only the catalog checks run', async () => {
    expect(await run(false)).toEqual([]);
  });
});
