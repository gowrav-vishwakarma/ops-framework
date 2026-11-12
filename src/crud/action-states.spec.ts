import { describe, expect, it } from 'vitest';
import type { EffectivePermissions } from '../acl/acl.service.js';
import type { LimitDef } from '../acl/limits.js';
import { allScope, branchScope, type ScopeDef } from '../acl/scopes.js';
import type { ReqCtx } from '../auth/auth-user.js';
import type { RowGuard } from './row-guard.js';
import { computeActionStates, type ActionStateEnv } from './action-states.js';
import type { EntityAction } from './entity-action.js';

const ctx: ReqCtx = { scope: 'all', limits: {}, user: { id: 1, platformUserId: 1, companyId: 1, epoch: 1, branchId: 2, branchIds: [2], roleId: 1, aclVersion: 0, partyId: null, name: 'T' } };
const row = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as never;
const amount: LimitDef<never> = { key: 'amount', label: 'Up to amount', type: 'money', value: (r: { get(k: string): number }) => r.get('total') } as never;

const approve: EntityAction = { name: 'approve', label: 'Approve', from: { status: ['draft'] }, limits: [amount] };
const reopen: EntityAction = { name: 'reopen', label: 'Reopen', skipGuards: ['frozen'] };

/** A project rule: rows dated before the prepared cut-off are frozen unless the caller holds `invoice.unfreeze`. */
const frozen: RowGuard<never> = {
  id: 'frozen',
  async reason({ row, prepared, can }) {
    const date = String((row as { get(k: string): unknown }).get('invoiceDate') ?? '');
    if (!date || date > String(prepared)) return null;
    return (await can('invoice.unfreeze')) ? null : `Frozen until ${String(prepared)}`;
  },
};
const restricted: EntityAction = { name: 'close', label: 'Close', available: (r) => (r.get('hasOpenItems') ? 'Open items remain' : null) };

const env: ActionStateEnv<never> = {
  resource: 'invoice',
  actions: [approve, reopen, restricted] as never,
  limits: {},
  guards: [frozen],
  scopes: new Map<string, ScopeDef>([['all', allScope], ['branch', branchScope]]),
  scopeEnv: { partyFields: [] },
  model: { getAttributes: () => ({}) },
  actionPermission: (action) => `invoice.${action.permission ?? action.name}`,
};
const grants = (entries: Record<string, { scope: string; limits?: Record<string, number> }>): EffectivePermissions =>
  new Map(Object.entries(entries).map(([code, g]) => [code, { scope: g.scope, limits: g.limits ?? {} }]));

describe('_actions: what each button can do on this row', () => {
  const full = grants({ 'invoice.update': { scope: 'all' }, 'invoice.delete': { scope: 'all' }, 'invoice.approve': { scope: 'all', limits: { amount: 1000 } }, 'invoice.reopen': { scope: 'all' }, 'invoice.close': { scope: 'all' } });

  it('is allowed when permission, state and limit all pass', async () => {
    const states = (await computeActionStates(env, ctx, row({ status: 'draft', total: 500, branchId: 2 }), full));
    expect(states.approve).toEqual({ allowed: true, reason: null });
    expect(states.update?.allowed).toBe(true);
  });

  it('gives the reason: no permission, wrong state, over limit, outside scope, unavailable', async () => {
    expect((await computeActionStates(env, ctx, row({ status: 'draft', total: 500 }), grants({}))).approve).toEqual({ allowed: false, reason: 'You do not have permission' });
    expect((await computeActionStates(env, ctx, row({ status: 'paid', total: 500 }), full)).approve?.reason).toContain('not possible while status is "paid"');
    expect((await computeActionStates(env, ctx, row({ status: 'draft', total: 5000 }), full)).approve?.reason).toBe('Above your limit of 1,000');
    const branchOnly = grants({ 'invoice.update': { scope: 'branch' } });
    expect((await computeActionStates(env, ctx, row({ branchId: 9 }), branchOnly)).update?.reason).toBe('Outside your access scope');
    expect((await computeActionStates(env, ctx, row({ hasOpenItems: true }), full)).close?.reason).toBe('Open items remain');
  });

  it('a project guard blocks edits, but not an action that skips it, nor a caller the guard lets through', async () => {
    const prepared = new Map([['frozen', '2026-03-31']]);
    const old = row({ invoiceDate: '2026-02-01', status: 'draft', total: 1 });
    const states = await computeActionStates(env, ctx, old, full, prepared);
    expect(states.update?.reason).toBe('Frozen until 2026-03-31');
    expect(states.reopen?.allowed).toBe(true);
    const unfreezer = new Map([...full, ['invoice.unfreeze', { scope: 'all', limits: {} }]]);
    expect((await computeActionStates(env, ctx, old, unfreezer, prepared)).update?.allowed).toBe(true);
  });
});
