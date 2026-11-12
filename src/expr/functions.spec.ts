import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileExpression, expressionFunctions, type ExpressionScope } from './evaluate.js';

const scope = (values: Record<string, unknown>): ExpressionScope => ({
  name: (path) => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' && Object.hasOwn(v, k) ? (v as Record<string, unknown>)[k] : undefined), values),
});
/** Runs an expression; `data` is the given object. */
const run = (source: string, data: Record<string, unknown> = {}) => compileExpression(source).run(scope({ data }));

/** A model instance as Sequelize gives it: values only through get(). */
const model = (values: Record<string, unknown>) => ({ get: (key: string) => values[key], dataValues: values });

describe('every function is covered here', () => {
  it('the list of functions is the one these specs test', () => {
    expect(expressionFunctions().sort()).toEqual(
      [
        'abs', 'adddays', 'any', 'ceil', 'coalesce', 'concat', 'count', 'date', 'day', 'daysbetween', 'distinct', 'either', 'every', 'except', 'filter', 'first', 'flatten', 'floor', 'fy', 'fystart',
        'greatest', 'idof', 'if', 'isnumber', 'islist', 'isobject', 'istext', 'least', 'left', 'length', 'lower', 'month', 'monthname', 'monthstart', 'now', 'nullif', 'number', 'pluck', 'right',
        'round', 'sum', 'text', 'today', 'trim', 'trynumber', 'union', 'upper', 'weekday', 'year',
      ].sort(),
    );
  });

  it('function names are not case sensitive', () => {
    expect(run("UPPER('a')")).toBe('A');
    expect(run('Coalesce(null, 1)')).toBe(1);
  });
});

describe('null handling', () => {
  it.each([
    'abs(null)', 'round(null)', 'round(null, 2)', 'floor(null)', 'ceil(null)', 'lower(null)', 'upper(null)', 'trim(null)', 'length(null)', 'left(null, 2)', 'right(null, 2)', 'text(null)', 'number(null)',
    'trynumber(null)', 'date(null)', 'year(null)', 'month(null)', 'day(null)', 'weekday(null)', 'monthstart(null)', 'monthname(null)', 'fystart(null)', 'fy(null)', 'daysbetween(null, \'2026-01-01\')',
    "daysbetween('2026-01-01', null)", 'adddays(null, 1)', 'first(null)', 'idof(null)', 'coalesce(null, null)', 'greatest(null, null)', 'least(null, null)', 'nullif(null, 1)', 'if(null, 1)',
  ])('%s is null', (source) => {
    expect(run(source)).toBeNull();
  });

  it('missing names are null too', () => {
    expect(run('upper(data.nothing)')).toBeNull();
    expect(run('round(data.nothing.deeper, 2)')).toBeNull();
  });

  it('list functions treat null as an empty list and skip null items where it matters', () => {
    expect(run('count(null)')).toBe(0);
    expect(run('sum(null)')).toBe(0);
    expect(run("pluck(null, 'a')")).toEqual([]);
    expect(run('distinct(data.v)', { v: [null, 1, null] })).toEqual([1]);
    expect(run('flatten(null)')).toEqual([]);
    expect(run('union(null, data.v)', { v: [1] })).toEqual([1]);
    expect(run('except(data.v, null)', { v: [1] })).toEqual([1]);
    expect(run("any(null, 'a')")).toBe(false);
    expect(run("every(null, 'a')")).toBe(true);
    expect(run("filter(null, 'a', 1)")).toEqual([]);
    expect(run('concat(null, null)')).toBe('');
  });

  it('a single value is a list of one', () => {
    expect(run('count(5)')).toBe(1);
    expect(run('first(5)')).toBe(5);
    expect(run("sum('2.5')")).toBe(2.5);
  });
});

describe('choosing a value', () => {
  it('coalesce takes the first value that is set (0, empty text and false are set)', () => {
    expect(run('coalesce(null, 0, 5)')).toBe(0);
    expect(run("coalesce(data.a, '', 'x')")).toBe('');
    expect(run('coalesce(data.a, false)')).toBe(false);
    expect(run('coalesce(data.a, data.b, 3)')).toBe(3);
  });

  it('either takes the first value that is set and not empty, zero or false; else the last', () => {
    expect(run("either(0, '', 5)")).toBe(5);
    expect(run("either(data.a, '', 'x')")).toBe('x');
    expect(run("either(0, '')")).toBe('');
    expect(run('either(null, 0)')).toBe(0);
    expect(run('either(null, null)')).toBeNull();
    expect(run("either('a', 'b')")).toBe('a');
  });

  it('nullif gives null when the two are equal (text numbers equal numbers)', () => {
    expect(run('nullif(0, 0)')).toBeNull();
    expect(run("nullif('5.0', 5)")).toBeNull();
    expect(run('nullif(4, 5)')).toBe(4);
  });

  it('if gives the second or the third input, null without a third; only the chosen branch is evaluated', () => {
    expect(run('if(true, 1, 2)')).toBe(1);
    expect(run('if(false, 1, 2)')).toBe(2);
    expect(run('if(false, 1)')).toBeNull();
    expect(run('if(0, 1, 2)')).toBe(2);
    expect(run("if(data.n = 0, 0, 100 / data.n)", { n: 0 })).toBe(0);
  });

  it('greatest and least skip nulls and compare text numbers as numbers', () => {
    expect(run('greatest(1, null, 3, 2)')).toBe(3);
    expect(run("greatest('10', 9)")).toBe('10');
    expect(run("least('10', 9, null)")).toBe(9);
    expect(run("greatest('b', 'a')")).toBe('b');
    expect(run("least('2026-01-02', '2026-01-01')")).toBe('2026-01-01');
  });
});

describe('numbers', () => {
  it('abs, floor, ceil read numbers sent as text', () => {
    expect(run("abs('-4.5')")).toBe(4.5);
    expect(run("floor('4.7')")).toBe(4);
    expect(run('floor(-4.2)')).toBe(-5);
    expect(run("ceil('4.2')")).toBe(5);
    expect(run("abs('x')")).toBeNull();
  });

  it('round: to digits, half away from zero, as text too', () => {
    expect(run('round(2.5)')).toBe(3);
    expect(run('round(-0.5)')).toBe(-1);
    expect(run('round(1.005, 2)')).toBe(1.01);
    expect(run('round(12.345, 2)')).toBe(12.35);
    expect(run("round('3.14159', 3)")).toBe(3.142);
    expect(run('round(1234.5, -2)')).toBe(1200);
    expect(run("round(2.345, 'x')")).toBe(2);
  });

  // BUG: round() nudges by Number.EPSILON, which is only big enough near 1. Halves of larger
  // numbers often round the wrong way: round(4.015, 2) gives 4.01 and round(2.135, 2) 2.13
  // (Postgres: 4.02, 2.14), and negative halves round up: round(-2.5) gives -2 (Postgres: -3). Money is rounded with this. Fix: round on the decimal
  // text, e.g. `Number(Math.sign(n) * Math.round(Number(`${Math.abs(n)}e${d}`)) + `e-${d}`)`, or
  // use `Number((Math.abs(n) * f).toPrecision(15))` before Math.round and put the sign back.
  it('round of halves matches Postgres', () => {
    expect(run('round(4.015, 2)')).toBe(4.02);
    expect(run("round('2.135', 2)")).toBe(2.14);
    expect(run('round(-2.5)')).toBe(-3);
    expect(run('round(-12.5)')).toBe(-13);
  });

  it('number reads text, empty text is null, booleans are 1 and 0', () => {
    expect(run("number('12.50')")).toBe(12.5);
    expect(run("number(' 7 ')")).toBe(7);
    expect(run("number('')")).toBeNull();
    expect(run("number('abc')")).toBeNull();
    expect(run('number(true)')).toBe(1);
    expect(run('number(data.v)', { v: [] })).toBeNull();
  });

  // BUG: number() and every number-as-text comparison use JavaScript's Number(), which reads
  // '0x10' as 16, '0b11' as 3 and 'Infinity' as a number; Postgres numeric refuses all three, and
  // trynumber() already refuses them. A request field '0x10' then passes `data.qty > 10`. Fix: in
  // `numeric()` accept only /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i text.
  it('number() reads decimal text only', () => {
    expect(run("number('0x10')")).toBeNull();
    expect(run("number('Infinity')")).toBeNull();
    expect(run("'0b11' = 3")).toBe(false);
  });

  it('trynumber reads plain decimal text only, numbers as they are', () => {
    expect(run("trynumber(' 12 ')")).toBe(12);
    expect(run("trynumber('-1.5')")).toBe(-1.5);
    expect(run("trynumber('1e3')")).toBeNull();
    expect(run("trynumber('12.')")).toBeNull();
    expect(run("trynumber('0x10')")).toBeNull();
    expect(run('trynumber(4)')).toBe(4);
    expect(run('trynumber(true)')).toBeNull();
  });

  it('arithmetic reads text numbers; division by zero is null', () => {
    expect(run("'2' + 3")).toBe(5);
    expect(run("'10' / '4'")).toBe(2.5);
    expect(run('7 % 3')).toBe(1);
    expect(run('7 % 0')).toBeNull();
    expect(run('-data.a', { a: '3' })).toBe(-3);
    expect(run("'a' + 1")).toBe('a1');
    expect(run("'a' + null")).toBeNull();
    expect(run("'a' - 1")).toBeNull();
    expect(run('null * 2')).toBeNull();
  });

  // BUG (or a limit to document): decimals are JavaScript floats, so 0.1 + 0.2 = 0.3 is false and
  // sum() of money lines drifts (0.30000000000000004). Postgres numeric is exact. Fix: round sums
  // and +, -, * results to 10 decimal places (`Number(x.toFixed(10))`), or compare numbers with a
  // tolerance in `compare()`.
  it.fails('decimal arithmetic is exact the way Postgres numeric is', () => {
    expect(run('0.1 + 0.2 = 0.3')).toBe(true);
    expect(run("sum(data.v, 'amount')", { v: [{ amount: '0.1' }, { amount: '0.2' }] })).toBe(0.3);
  });
});

describe('text', () => {
  it('lower, upper, trim, length, left, right, concat, text', () => {
    expect(run("lower('AbC')")).toBe('abc');
    expect(run('upper(5)')).toBe('5');
    expect(run("trim('  a b  ')")).toBe('a b');
    expect(run("length('abc')")).toBe(3);
    expect(run('length(data.v)', { v: [1, 2] })).toBe(2);
    expect(run('length(12.5)')).toBe(4);
    expect(run("left('abcdef', 2)")).toBe('ab');
    expect(run("left('abcdef', '3')")).toBe('abc');
    expect(run("left('abcdef', -2)")).toBe('abcd');
    expect(run("right('abcdef', 2)")).toBe('ef');
    expect(run("right('abc', 0)")).toBe('');
    expect(run("right('abc', 9)")).toBe('abc');
    expect(run("concat('a', null, 1, true)")).toBe('a1true');
    expect(run('text(12.5)')).toBe('12.5');
    expect(run('text(data.d)', { d: new Date('2026-02-01T10:00:00Z') })).toBe('2026-02-01T10:00:00.000Z');
  });

  it('contains, starts and ends ignore case; null is unknown', () => {
    expect(run("data.n contains 'TRAD'", { n: 'Shiv Traders' })).toBe(true);
    expect(run("data.n starts 'shiv'", { n: 'Shiv Traders' })).toBe(true);
    expect(run("data.n ends 'ERS'", { n: 'Shiv Traders' })).toBe(true);
    expect(run("data.n not contains 'x'", { n: 'Shiv' })).toBe(true);
    expect(run("data.n contains 'x'")).toBeNull();
    expect(run('data.n contains null', { n: 'a' })).toBeNull();
  });
});

describe('dates', () => {
  afterEach(() => vi.useRealTimers());

  it('date takes days, timestamps and Date objects; anything else is null', () => {
    expect(run("date('2026-02-10')")).toBe('2026-02-10');
    expect(run("date('2026-02-10T18:30:00Z')")).toBe('2026-02-10');
    expect(run('date(data.d)', { d: new Date('2026-02-10T05:00:00Z') })).toBe('2026-02-10');
    expect(run("date('not a date')")).toBeNull();
    expect(run("date('')")).toBeNull();
  });

  it('year, month, day, weekday (Monday 1 .. Sunday 7)', () => {
    expect(run("year('2026-11-12')")).toBe(2026);
    expect(run("month('2026-11-12')")).toBe(11);
    expect(run("day('2026-11-12')")).toBe(12);
    expect(run("weekday('2026-11-12')")).toBe(4);
    expect(run("weekday('2026-11-15')")).toBe(7);
    expect(run("weekday('2026-11-16')")).toBe(1);
  });

  it('monthstart and monthname', () => {
    expect(run("monthstart('2026-02-17')")).toBe('2026-02-01');
    expect(run("monthname('2026-02-17')")).toBe('Feb 2026');
    expect(run("monthname('2026-12-31')")).toBe('Dec 2026');
  });

  it('Indian financial years start on 1 April', () => {
    expect(run("fy('2026-03-31')")).toBe('2025-26');
    expect(run("fy('2026-04-01')")).toBe('2026-27');
    expect(run("fy('2099-06-01')")).toBe('2099-00');
    expect(run("fystart('2026-03-31')")).toBe('2025-04-01');
    expect(run("fystart('2026-04-01')")).toBe('2026-04-01');
  });

  it('daysbetween and adddays, across months and leap years, days as text', () => {
    expect(run("daysbetween('2026-03-01', '2026-01-01')")).toBe(-59);
    expect(run("daysbetween('2028-02-01', '2028-03-01')")).toBe(29);
    expect(run("adddays('2028-02-28', 1)")).toBe('2028-02-29');
    expect(run("adddays('2026-02-28', '1')")).toBe('2026-03-01');
    expect(run("adddays('2026-01-01', -1)")).toBe('2025-12-31');
    // A missing number of days adds none.
    expect(run("adddays('2026-01-01', null)")).toBe('2026-01-01');
  });

  it('today is the day (UTC) as text; now is the moment', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
    expect(run('today()')).toBe('2026-11-12');
    expect(run('now()')).toEqual(new Date('2026-11-12T10:00:00Z'));
    expect(run("daysbetween('2026-11-01', today())")).toBe(11);
  });

  it('compares days as text and Date objects with days', () => {
    expect(run("data.d > '2026-01-31'", { d: '2026-02-01' })).toBe(true);
    expect(run("data.d = '2026-02-01'", { d: new Date('2026-02-01T00:00:00Z') })).toBe(true);
    expect(run("data.d between '2026-04-01' and '2027-03-31'", { d: new Date('2026-05-01T00:00:00Z') })).toBe(true);
  });
});

describe('what a value is', () => {
  it.each([
    ['istext', "'a'", true], ['istext', '1', false], ['istext', 'null', false],
    ['isnumber', '1.5', true], ['isnumber', "'1'", false], ['isnumber', 'null', false],
    ['islist', 'data.list', true], ['islist', 'data.obj', false],
    ['isobject', 'data.obj', true], ['isobject', 'data.list', false], ['isobject', 'data.date', false], ['isobject', 'null', false], ['isobject', 'data.model', true],
  ])('%s(%s) is %s', (fn, arg, expected) => {
    expect(run(`${fn}(${arg})`, { list: [1], obj: { a: 1 }, date: new Date(), model: model({ id: 1 }) })).toBe(expected);
  });

  it('idof: the id of a reference sent as an id or as a record; text ids are not ids', () => {
    expect(run('idof(9)')).toBe(9);
    expect(run('idof(data.p)', { p: { id: 9, name: 'Ravi' } })).toBe(9);
    expect(run('idof(data.p)', { p: model({ id: 4 }) })).toBe(4);
    expect(run('idof(data.p)', { p: { id: '9' } })).toBeNull();
    expect(run("idof('9')")).toBeNull();
    expect(run('idof(data.p)', { p: { name: 'x' } })).toBeNull();
    expect(run('idof(data.p)', { p: [9] })).toBeNull();
  });
});

describe('lists', () => {
  const plain = [{ qty: 2, isService: false, batch: { id: 4 } }, { qty: '3.5', isService: true, batch: { id: 4 } }, { qty: 1, isService: false, batch: null }];
  const models = plain.map((item) => model({ ...item, batch: item.batch ? model(item.batch) : null }));

  describe.each([
    ['plain objects', plain],
    ['model instances (get)', models],
  ])('with %s', (_label, items) => {
    it('count, sum, pluck, distinct by path, through nested records', () => {
      expect(run('count(data.items)', { items })).toBe(3);
      expect(run("count(data.items, 'isService')", { items })).toBe(1);
      expect(run("sum(data.items, 'qty')", { items })).toBe(6.5);
      expect(run("pluck(data.items, 'batch.id')", { items })).toEqual([4, 4, null]);
      expect(run("distinct(data.items, 'batch.id')", { items })).toEqual([4]);
    });

    it('any, every and filter with and without a value', () => {
      expect(run("any(data.items, 'isService')", { items })).toBe(true);
      expect(run("any(data.items, 'qty', '3.5')", { items })).toBe(true);
      expect(run("any(data.items, 'qty', 9)", { items })).toBe(false);
      expect(run("every(data.items, 'qty')", { items })).toBe(true);
      expect(run("every(data.items, 'isService', false)", { items })).toBe(false);
      expect(run("count(filter(data.items, 'isService', false))", { items })).toBe(2);
      expect(run("count(filter(data.items, 'batch.id', 4))", { items })).toBe(2);
      expect(run("filter(data.items, 'qty', null)", { items })).toEqual([]);
    });

    it('first gives the first item itself', () => {
      expect(run('first(data.items)', { items })).toBe(items[0]);
    });
  });

  it('distinct keeps the first of equal values; 1 and "1" are equal; dates by their moment', () => {
    expect(run('distinct(data.v)', { v: [3, '3', 1, 3, 'a', 'a'] })).toEqual([3, 1, 'a']);
    const d = [new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z')];
    expect(run('distinct(data.v)', { v: d })).toEqual([d[0]]);
  });

  it('flatten opens one level', () => {
    expect(run('flatten(data.v)', { v: [1, [2, [3]], null] })).toEqual([1, 2, [3]]);
  });

  it('union joins lists as they are (duplicates kept: distinct removes them); except removes by value', () => {
    expect(run('union(data.a, data.b, 5)', { a: ['S1'], b: ['S1', 'S2'] })).toEqual(['S1', 'S1', 'S2', 5]);
    expect(run('distinct(union(data.a, data.b))', { a: ['S1'], b: ['S1', 'S2'] })).toEqual(['S1', 'S2']);
    expect(run('except(data.a, data.b)', { a: [1, 2, '3', 3], b: ['2', 3] })).toEqual([1]);
  });

  it('first of an empty list is null', () => {
    expect(run('first(data.v)', { v: [] })).toBeNull();
  });

  it('in reads a list name too', () => {
    expect(run('2 in (data.a, 2)', { a: 1 })).toBe(true);
    expect(run('3 not in (1, 2)')).toBe(true);
    expect(run('null in (1, 2)')).toBeNull();
  });
});

describe('conditions', () => {
  it('and / or / not with SQL three-valued logic', () => {
    expect(run('null and true')).toBeNull();
    expect(run('null and false')).toBe(false);
    expect(run('null or true')).toBe(true);
    expect(run('null or false')).toBeNull();
    expect(run('not null')).toBeNull();
    expect(run('not (1 = 2)')).toBe(true);
  });

  it('is null, is empty, between with null', () => {
    expect(run('data.a is null')).toBe(true);
    expect(run("data.a is empty", { a: '' })).toBe(true);
    expect(run('data.a is empty', { a: [] })).toBe(true);
    expect(run('data.a is not empty', { a: [0] })).toBe(true);
    expect(run("data.a is null", { a: '' })).toBe(false);
    expect(run('data.a between 1 and 3')).toBeNull();
    expect(run('5 not between 1 and 3')).toBe(true);
  });

  it('numbers sent as text compare as numbers; other text as text', () => {
    expect(run("'10' > '9'")).toBe(true);
    expect(run("'10' > 9")).toBe(true);
    expect(run("'abc' < 'abd'")).toBe(true);
    expect(run("'1500.00' = 1500")).toBe(true);
    expect(run('true = 1')).toBe(true);
    expect(run("'B1' > 'A9'")).toBe(true);
  });
});
