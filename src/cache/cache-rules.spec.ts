import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from 'sequelize';
import { CacheRules, type CacheRule } from './cache-rules.js';

function rules(list: CacheRule[]) {
  const service = new CacheRules({ get: (token: unknown) => token } as never, { cacheRules: list } as never);
  return service;
}

function transaction(parent?: Transaction) {
  const hooks: Array<() => unknown> = [];
  const t = { parent, afterCommit: (fn: () => unknown) => hooks.push(fn) } as unknown as Transaction;
  return { t, commit: async () => { for (const fn of hooks) await fn(); }, hooks };
}

const row = (data: Record<string, unknown>) => ({ get: () => data }) as never;

describe('cache rules', () => {
  it('clears once after commit, with every company the transaction touched (savepoints follow the outer transaction)', async () => {
    const clear = vi.fn();
    const service = rules([{ id: 'ctx', models: ['Series', 'Branch'], clear }]);
    const outer = transaction();
    const inner = transaction(outer.t);
    service.written('Series', [row({ companyId: 3 }), row({ companyId: 3 })], outer.t);
    service.written('Branch', [row({ companyId: 4 })], inner.t);
    expect(inner.hooks).toHaveLength(0);
    expect(clear).not.toHaveBeenCalled();
    await outer.commit();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear.mock.calls[0]![0]).toEqual([3, 4]);
  });

  it('a bulk statement names its company by its condition; an unwatched model is ignored; a rule may say where the company is', async () => {
    const clear = vi.fn();
    const own = vi.fn();
    const service = rules([
      { id: 'ctx', models: ['Series'], clear },
      { id: 'company', models: ['AnkpalCompany'], companyOf: (r) => r.id as number, clear: own },
    ]);
    const { t, commit } = transaction();
    service.written('Series', [], t, { companyId: 9, isActive: true });
    service.written('AnkpalCompany', [row({ id: 12 })], t);
    expect(service.watches('Product')).toBe(false);
    await commit();
    expect(clear.mock.calls[0]![0]).toEqual([9]);
    expect(own.mock.calls[0]![0]).toEqual([12]);
  });

  it('without a transaction clears on the next tick; a failing rule is logged, not thrown', async () => {
    const clear = vi.fn((_companies: readonly number[]) => Promise.reject(new Error('redis down')));
    const service = rules([{ id: 'ctx', models: ['Series'], clear }]);
    service.written('Series', [row({ companyId: 5 })], undefined);
    service.written('Series', [row({ companyId: 6 })], undefined);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear.mock.calls[0]![0]).toEqual([5, 6]);
  });
});
