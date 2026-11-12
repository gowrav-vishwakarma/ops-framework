import { describe, expect, it } from 'vitest';
import type { ReqCtx } from '../auth/auth-user.js';
import { Issues } from '../crud/issues.js';
import { checkLimits, limitReason, PermissionMeta, type LimitDef } from './limits.js';

const ctx = (limits: Record<string, number>): ReqCtx => ({ scope: 'all', limits, user: {} as never });
const amount: LimitDef<{ total: number }> = { key: 'amount', label: 'Up to amount', type: 'money', value: (row) => row.total };

describe('limits', () => {
  it('blocks a record above the stored limit and names both numbers', () => {
    const issues = new Issues();
    checkLimits(issues, ctx({ amount: 25_000 }), { total: 40_000 }, [amount], 'Approve');
    expect(issues.blockers.map((b) => b.code)).toEqual(['limit_exceeded']);
    expect(issues.blockers[0]?.message).toContain('25,000');
    expect(issues.blockers[0]?.message).toContain('40,000');
  });

  it('lets through a record at or below the limit, and anything when no limit is stored', () => {
    const issues = new Issues();
    checkLimits(issues, ctx({ amount: 25_000 }), { total: 25_000 }, [amount], 'Approve');
    checkLimits(issues, ctx({}), { total: 9_999_999 }, [amount], 'Approve');
    expect(issues.failed).toBe(false);
  });

  it('gives the reason without an Issues object, for _actions', () => {
    expect(limitReason(ctx({ amount: 100 }), { total: 101 }, [amount])).toBe('Above your limit of 100');
    expect(limitReason(ctx({ amount: 100 }), { total: 100 }, [amount])).toBeNull();
  });

  it('keeps declared limits and hidden codes for the permission matrix', () => {
    const meta = new PermissionMeta();
    meta.declareLimits('invoice.approve', [amount as never]);
    meta.hide('period.unlock');
    expect(meta.limits('invoice.approve')).toEqual([{ key: 'amount', label: 'Up to amount', type: 'money' }]);
    expect(meta.limits('invoice.view')).toEqual([]);
    expect(meta.isHidden('period.unlock')).toBe(true);
  });
});
