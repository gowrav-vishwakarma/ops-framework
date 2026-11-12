import { describe, expect, it } from 'vitest';
import { compileExpression, defineExpressionFunction, ExpressionError, type ExpressionScope } from './evaluate.js';

const scope = (values: Record<string, unknown>): ExpressionScope => ({
  name: (path) => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), values),
  param: (id) => values[`@${id}`],
});
const run = (source: string, values: Record<string, unknown> = {}) => compileExpression(source).run(scope(values));

describe('expressions', () => {
  it('computes values: arithmetic, decimals that arrive as text, functions', () => {
    expect(run('data.qty * data.rate', { data: { qty: 3, rate: '12.50' } })).toBe(37.5);
    expect(run('round(10 / 3, 2)')).toBe(3.33);
    expect(run("coalesce(data.discount, 0) + 1", { data: {} })).toBe(1);
    expect(run("concat(upper(data.code), '-', 7)", { data: { code: 'ab' } })).toBe('AB-7');
    expect(run("if(data.amount < 0, -data.amount, 0)", { data: { amount: -5 } })).toBe(5);
  });

  it('decides conditions with SQL null rules', () => {
    expect(run("data.status = 'active' and data.amount > 1000", { data: { status: 'active', amount: '1500.00' } })).toBe(true);
    expect(run('data.missing = 1', { data: {} })).toBeNull();
    expect(run('data.missing = 1 or true', { data: {} })).toBe(true);
    expect(run('data.missing = 1 and false', { data: {} })).toBe(false);
    expect(run('data.name is empty', { data: { name: '' } })).toBe(true);
    expect(run("data.name contains 'TRAD'", { data: { name: 'Shiv Traders' } })).toBe(true);
    expect(run('data.branchId in (1, 2)', { data: { branchId: 2 } })).toBe(true);
    expect(run('data.d between @from and @to', { data: { d: '2026-05-01' }, '@from': '2026-04-01', '@to': '2027-03-31' })).toBe(true);
    expect(run('10 / 0')).toBeNull();
  });

  it('knows Indian financial years and dates', () => {
    expect(run("fy('2026-02-10')")).toBe('2025-26');
    expect(run("fystart('2026-05-10')")).toBe('2026-04-01');
    expect(run("adddays('2026-01-30', 3)")).toBe('2026-02-02');
    expect(run("daysbetween('2026-01-01', '2026-03-01')")).toBe(59);
  });

  it('refuses what is not an expression: unknown functions, bad arity, report-only functions, overlong input', () => {
    expect(() => compileExpression('eval(1)')).toThrow(ExpressionError);
    expect(() => compileExpression('round()')).toThrow(/takes 1 to 2/);
    expect(() => compileExpression('x in under(@g)')).toThrow(/reports only/);
    expect(() => compileExpression('1 +'.repeat(800))).toThrow(ExpressionError);
    expect(() => compileExpression("data.name; drop table x")).toThrow(ExpressionError);
  });

  it('takes project functions', () => {
    defineExpressionFunction('stateOfGstin', { min: 1, max: 1, run: ([gstin]) => String(gstin).slice(0, 2) });
    expect(run("stateOfGstin('27ABCDE1234F1Z5')")).toBe('27');
  });

  it('reads lists like sentences: count, sum, pluck, distinct, union, except, any, every, filter, idof', () => {
    const items = [{ qty: 2, isService: false, batch: { id: 4 } }, { qty: '3.5', isService: true, batch: { id: 4 } }, { qty: 1, isService: false, batch: null }];
    expect(run('count(data.items)', { data: { items } })).toBe(3);
    expect(run("count(data.items, 'isService')", { data: { items } })).toBe(1);
    expect(run("sum(data.items, 'qty')", { data: { items } })).toBe(6.5);
    expect(run("pluck(data.items, 'batch.id')", { data: { items } })).toEqual([4, 4, null]);
    expect(run("distinct(data.items, 'batch.id')", { data: { items } })).toEqual([4]);
    expect(run("any(data.items, 'isService')", { data: { items } })).toBe(true);
    expect(run("every(data.items, 'qty')", { data: { items } })).toBe(true);
    expect(run("count(filter(data.items, 'isService', false))", { data: { items } })).toBe(2);
    expect(run('union(data.a, data.b)', { data: { a: ['S1'], b: ['S2', 'S3'] } })).toEqual(['S1', 'S2', 'S3']);
    expect(run('except(data.a, data.b)', { data: { a: ['S1', 'S2', 'S3'], b: ['S2'] } })).toEqual(['S1', 'S3']);
    expect(run('first(data.a)', { data: { a: [] } })).toBeNull();
    expect(run('idof(data.p)', { data: { p: { id: 9, name: 'Ravi' } } })).toBe(9);
    expect(run('idof(data.p)', { data: { p: 9 } })).toBe(9);
    expect(run('idof(data.p)', { data: { p: '9' } })).toBeNull();
  });
});
