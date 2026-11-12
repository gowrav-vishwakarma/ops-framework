import { describe, expect, it } from 'vitest';
import { FlowRun } from '../flow/run.js';
import { boot, flowCtx, MemoryDb } from '../flow/testing.spec-helpers.js';
import { compileExpression, defineExpressionFunction, ExpressionError, type ExpressionScope } from './evaluate.js';
import { parseExpression } from './parse.js';

/** Expressions as a flow runs them: the real FlowRun scope over a request body. */
const flowRun = (dto: Record<string, unknown> = {}) => new FlowRun(flowCtx(new MemoryDb(), { dto, user: { id: 1 } }), 'check', 'x.ts', {});
const inFlow = (source: string, dto: Record<string, unknown> = {}) => flowRun(dto).value(source);

describe('limits', () => {
  it('length: 2000 characters at most', () => {
    const at = `'${'a'.repeat(1998)}'`;
    expect(at).toHaveLength(2000);
    expect(compileExpression(at).run({ name: () => undefined })).toHaveLength(1998);
    expect(() => compileExpression(`'${'a'.repeat(1999)}'`)).toThrow(/longer than 2000 characters/);
  });

  it('depth: 40 levels of brackets, calls, not or minus at most', () => {
    const nested = (n: number) => `${'('.repeat(n)}1${')'.repeat(n)}`;
    expect(compileExpression(nested(40)).run({ name: () => undefined })).toBe(1);
    expect(() => compileExpression(nested(41))).toThrow(/nested too deeply/);
    expect(() => compileExpression(`${'not '.repeat(41)}true`)).toThrow(/nested too deeply/);
    expect(() => compileExpression(`${'-'.repeat(41)}1`)).toThrow(/nested too deeply/);
    expect(() => compileExpression(`${'abs('.repeat(41)}1${')'.repeat(41)}`)).toThrow(/nested too deeply/);
  });

  it('a long flat chain stays within the length limit and evaluates', () => {
    const chain = Array.from({ length: 600 }, () => '1').join('+');
    expect(compileExpression(chain).run({ name: () => undefined })).toBe(600);
  });

  it('a wrong number of inputs fails when compiled, not when run', () => {
    expect(() => compileExpression('today(1)')).toThrow(/today\(\) takes 0 inputs/);
    expect(() => compileExpression("left('a')")).toThrow(/left\(\) takes 2 inputs/);
    expect(() => compileExpression('coalesce()')).toThrow(/takes 1 to 12 inputs/);
    expect(() => compileExpression(`concat(${Array(13).fill('1').join(',')})`)).toThrow(/takes 1 to 12 inputs/);
    expect(() => compileExpression('upper(lower(1, 2))')).toThrow(/lower\(\) takes 1 inputs/);
  });
});

describe('injection: an expression is a value, never code', () => {
  it.each([
    'data.name; drop table x',
    "data.name' or '1'='1",
    'data[0]',
    "data['constructor']",
    '`x`',
    '${process.env}',
    'a => a',
    'data.x()',
    '(function(){})()',
    'new Function("return process")()',
    "eval('1')",
    'require("fs")',
    'import("fs")',
    '\\u0061',
    'data.toString()',
    'constructor(1)',
    '__proto__(1)',
  ])('refuses %s', (source) => {
    expect(() => compileExpression(source)).toThrow(ExpressionError);
  });

  it('quotes inside text are doubled, never closing the text early', () => {
    expect(compileExpression("'it''s'").run({ name: () => undefined })).toBe("it's");
    expect(compileExpression("'a\" or 1=1 --'").run({ name: () => undefined })).toBe('a" or 1=1 --');
    expect(() => compileExpression("'open")).toThrow(/not closed/);
  });

  it('function names are looked up in a list of their own: object internals are not functions', () => {
    for (const name of ['constructor', 'tostring', 'valueof', 'hasownproperty', '__proto__', '__definegetter__']) {
      expect(() => compileExpression(`${name}(1)`)).toThrow(/Unknown function/);
    }
    defineExpressionFunction('specSafeFn', { min: 0, max: 0, run: () => 'ok' });
    expect(compileExpression('specsafefn()').run({ name: () => undefined })).toBe('ok');
    expect(() => defineExpressionFunction('UPPER', { min: 1, max: 1, run: () => 'hijacked' })).toThrow(/already exists/);
  });

  it('parameters do not exist in flows', () => {
    expect(() => inFlow('@constructor')).toThrow(/no parameters here/);
  });

  // `data.a = 1 -- note` parses as `data.a = 1 - (-note)`: `note` is an unknown name, so boot refuses it.
  it('names outside the scope fail boot: process, globalThis, constructor, __proto__, this', () => {
    for (const root of ['process', 'globalThis', 'constructor', '__proto__', 'require', 'module', 'Function', 'run', 'c', 'this', 'comment']) {
      expect(boot([{ kind: 'block', message: 'm', when: `${root}.x = 1` }]), root).toThrow(new RegExp(`unknown name "${root}"`));
      expect(() => inFlow(`${root}.x`), root).toThrow(new RegExp(`unknown name "${root}"`));
    }
  });

  it('nothing climbs from a value to the Function constructor, process or the flow context', () => {
    expect(inFlow('data.constructor.constructor')).toBeNull();
    expect(inFlow('data.constructor.name')).toBeNull();
    expect(inFlow('data.name.constructor', { name: 'x' })).toBeNull();
    expect(inFlow('data.name.length', { name: 'abc' })).toBeNull();
    expect(inFlow('user.constructor.constructor')).toBeNull();
    expect(inFlow('data.a.constructor.prototype', { a: [] })).toBeNull();
  });

  it('own fields named like internals are plain data', () => {
    const body = JSON.parse('{"__proto__": {"x": 1}, "constructor": "c"}') as Record<string, unknown>;
    expect(inFlow('data.__proto__.x', body)).toBe(1);
    expect(inFlow('data.constructor', body)).toBe('c');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  // BUG: names read inherited properties of plain objects: `data.__proto__` is Object.prototype,
  // `data.constructor` the Object function, `data.toString` a function. They cannot be called and
  // nothing below them is reachable (rowValue only walks objects), but they are not values of the
  // request and leak into text (`concat(data.constructor)` is "function Object() { [native code] }")
  // and into steps (`assign`, `create` values). Fix: in `rowValue` (flow/run.ts) and `pick`
  // (expr/evaluate.ts) read plain objects with `Object.hasOwn(row, field) ? row[field] : undefined`.
  it('inherited properties read as null', () => {
    expect(inFlow('data.__proto__')).toBeNull();
    expect(inFlow('data.constructor')).toBeNull();
    expect(inFlow('data.toString')).toBeNull();
    expect(inFlow('state.hasOwnProperty')).toBeNull();
  });

  it('list paths read only own fields too', () => {
    const scope: ExpressionScope = { name: () => [{ a: 1 }] };
    expect(compileExpression("pluck(data.items, 'constructor')").run(scope)).toEqual([null]);
    expect(compileExpression("pluck(data.items, '__proto__')").run(scope)).toEqual([null]);
  });

  it('the parser makes plain trees: no prototype tricks in names', () => {
    expect(parseExpression('data.__proto__')).toEqual({ k: 'name', v: 'data.__proto__' });
    expect(parseExpression("concat('__proto__')")).toEqual({ k: 'call', fn: 'concat', args: [{ k: 'str', v: '__proto__' }] });
  });
});
