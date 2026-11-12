import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { ScopeRegistry } from '../acl/scope-registry.js';
import type { ReqCtx } from '../auth/auth-user.js';
import { RowGuardRegistry } from './row-guard.js';
import { asSystem, runAsOperation, WriteGuard, type OperationAccess } from './write-guard.js';

const model = (name: string, fields: string[]) => ({ name, getAttributes: () => Object.fromEntries(fields.map((f) => [f, {}])) }) as never;
const row = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] }) as never;
const ctx = (scope: string): ReqCtx => ({ scope, scopeParams: {}, limits: {}, user: { id: 7, companyId: 1, branchId: 1, branchIds: [1, 2], roleId: 1, partyId: null, name: 'u' } }) as never;

function setup() {
  const guards = new RowGuardRegistry();
  guards.register('Stock', [{ id: 'fy', reason: ({ row: r }) => ((r as { get(k: string): unknown }).get('closed') ? 'The financial year is closed' : null) }]);
  const guard = new WriteGuard(new ScopeRegistry({} as never), guards, { get: () => undefined } as never);
  guard.onModuleInit();
  return guard;
}
const access = (scope: string, overrides: Partial<OperationAccess> = {}): OperationAccess => ({ ctx: ctx(scope) as never, can: async () => true, model: 'Invoice', scopeEnv: { partyFields: [] }, skipGuards: [], ...overrides });
const inRequest = <T>(work: () => Promise<T>) => ClsServiceManager.getClsService().run(work);
const Stock = model('Stock', ['branchId', 'createdById', 'closed']);
const Invoice = model('Invoice', ['branchId', 'createdById']);

describe('write guard: every write of an operation', () => {
  it('passes the row guards of the model written, from any code', async () => {
    const guard = setup();
    await inRequest(() => runAsOperation(access('all'), async () => {
      await expect(guard.check(Stock, 'update', row({ closed: true }), {}, undefined)).rejects.toThrow('The financial year is closed');
      await expect(guard.check(Stock, 'update', row({ closed: false }), {}, undefined)).resolves.toBeUndefined();
    }));
  });

  it('keeps related rows inside a branch scope, both before and after the change', async () => {
    const guard = setup();
    await inRequest(() => runAsOperation(access('branch'), async () => {
      await expect(guard.check(Stock, 'create', row({ branchId: 2 }), null, undefined)).resolves.toBeUndefined();
      await expect(guard.check(Stock, 'create', row({ branchId: 9 }), null, undefined)).rejects.toThrow('Outside your access scope (Stock)');
      await expect(guard.check(Stock, 'update', row({ branchId: 1 }), { branchId: 9 }, undefined)).rejects.toThrow('Outside your access scope');
    }));
  });

  it('limits only the operation\'s own records by ownership; asSystem lifts the scope, not the guards', async () => {
    const guard = setup();
    await inRequest(() => runAsOperation(access('own'), async () => {
      await expect(guard.check(Stock, 'update', row({ createdById: 99 }), { createdById: 99 }, undefined)).resolves.toBeUndefined();
      await expect(guard.check(Invoice, 'create', row({ createdById: 99 }), null, undefined)).rejects.toThrow('Outside your access scope (Invoice)');
    }));
    await inRequest(() => runAsOperation(access('branch'), () => asSystem(async () => {
      await expect(guard.check(Stock, 'create', row({ branchId: 9 }), null, undefined)).resolves.toBeUndefined();
      await expect(guard.check(Stock, 'create', row({ branchId: 9, closed: true }), null, undefined)).rejects.toThrow('closed');
    })));
  });

  it('does nothing outside an operation (sign-in, jobs)', async () => {
    const guard = setup();
    await expect(guard.check(Stock, 'create', row({ branchId: 9, closed: true }), null, undefined)).resolves.toBeUndefined();
  });
});
