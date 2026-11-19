import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkPayload, payloadProblems, payloadWarnings, resetPayloadWarnings } from './check-payload.js';
import { PayloadPipe } from './payload-pipe.js';

class Line {
  @IsInt() productId!: number;
  @IsInt() qty!: number;
}
class Invoice {
  @IsString() number!: string;
  @IsOptional() @IsIn(['cash', 'credit']) mode?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => Line) lines!: Line[];
}

const good = { number: 'SI-1', lines: [{ productId: 1, qty: 2 }] };
const check = (payload: unknown, mode: 'off' | 'warn' | 'error') => checkPayload(Invoice, payload, { endpoint: 'SalesInvoice create', mode });
const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { getResponse(): { errors: Record<string, string[]> } }).getResponse().errors;
  }
  throw new Error('not refused');
};

describe('checkPayload: a payload held to its DTO', () => {
  beforeEach(() => resetPayloadWarnings());

  it('a payload that fits comes back as the class, in every mode, with nothing reported', () => {
    for (const mode of ['off', 'warn', 'error'] as const) expect(check(good, mode)).toBeInstanceOf(Invoice);
    expect(payloadWarnings()).toEqual([]);
  });

  it('off: unknown fields (top level and inside lines) dropped silently', () => {
    const out = check({ ...good, extra: 1, lines: [{ productId: 1, qty: 2, display: 'x' }] }, 'off');
    expect(out).toEqual({ number: 'SI-1', lines: [{ productId: 1, qty: 2 }] });
    expect(payloadWarnings()).toEqual([]);
  });

  it('warn: unknown fields dropped and reported per endpoint, array positions folded to *', () => {
    const payload = { ...good, extra: 1, lines: [{ productId: 1, qty: 2, display: 'x' }, { productId: 2, qty: 1, display: 'y' }] };
    expect(check(payload, 'warn')).toEqual({ number: 'SI-1', lines: [{ productId: 1, qty: 2 }, { productId: 2, qty: 1 }] });
    check(payload, 'warn');
    expect(payloadWarnings()).toEqual([
      { endpoint: 'SalesInvoice create', field: 'extra', count: 2 },
      { endpoint: 'SalesInvoice create', field: 'lines.*.display', count: 2 },
    ]);
  });

  it('error: unknown fields refused, each named where it is', () => {
    expect(refusal(() => check({ ...good, extra: 1, lines: [{ productId: 1, qty: 2, display: 'x' }] }, 'error'))).toEqual({
      extra: ['extra is not a field of this payload'],
      'lines.0.display': ['display is not a field of this payload'],
    });
  });

  it('wrong, missing and out-of-list fields are refused in every mode, all together', () => {
    for (const mode of ['off', 'warn', 'error'] as const) {
      const errors = refusal(() => check({ mode: 'upi', lines: [{ productId: 'abc' }] }, mode));
      expect(Object.keys(errors).sort()).toEqual(['lines.0.productId', 'lines.0.qty', 'mode', 'number']);
    }
  });

  it('a body that is no object is refused', () => {
    expect(payloadProblems(Invoice, [1], { endpoint: 'x', mode: 'warn' }).errors).toEqual({ body: ['must be an object'] });
    expect(payloadProblems(Invoice, null, { endpoint: 'x', mode: 'warn' }).errors).toEqual({ body: ['must be an object'] });
  });

  it('refuse: the app turns the field errors into its own answer', () => {
    const own = new Error('own');
    expect(() => checkPayload(Invoice, {}, { endpoint: 'x', mode: 'error', refuse: () => own })).toThrow(own);
  });
});

describe('PayloadPipe: controller bodies and queries typed with a class', () => {
  beforeEach(() => resetPayloadWarnings());

  it('checks a class-typed body; passes Object-typed bodies untouched; converts named number / boolean params as Nest does', () => {
    const pipe = new PayloadPipe('error');
    expect(pipe.transform(good, { type: 'body', metatype: Invoice })).toBeInstanceOf(Invoice);
    expect(() => pipe.transform({ ...good, extra: 1 }, { type: 'body', metatype: Invoice })).toThrow();
    const loose = { anything: 1 };
    expect(pipe.transform(loose, { type: 'body', metatype: Object })).toBe(loose);
    expect(pipe.transform('5', { type: 'param', metatype: Number, data: 'id' })).toBe(5);
    expect(pipe.transform('true', { type: 'query', metatype: Boolean, data: 'all' })).toBe(true);
    expect(pipe.transform(undefined, { type: 'query', metatype: Number, data: 'limit' })).toBeUndefined();
    expect(pipe.transform('true', { type: 'query', metatype: String, data: 'confirm' })).toBe('true');
  });

  it('warn: reports under the class name', () => {
    new PayloadPipe('warn').transform({ ...good, extra: 1 }, { type: 'body', metatype: Invoice });
    expect(payloadWarnings()).toEqual([{ endpoint: 'body Invoice', field: 'extra', count: 1 }]);
  });
});
