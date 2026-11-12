import { ConflictException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseError, ForeignKeyConstraintError, UniqueConstraintError, ValidationError, ValidationErrorItem } from 'sequelize';
import { describe, expect, it, vi } from 'vitest';
import { databaseErrorAnswer, ErrorAnswerFilter } from './database-errors.js';

const pg = (fields: Record<string, unknown>) => Object.assign(new Error('pg says something internal'), fields);
const body = (error: unknown) => (databaseErrorAnswer(error) as HttpException).getResponse();

describe('database refusals as answers', () => {
  it('a duplicate names the field, never the company', () => {
    expect(body(new UniqueConstraintError({ fields: { name: 'Freight', companyId: 1 } } as never))).toEqual({ message: 'A record with these values already exists', errors: { name: ['Name already exists'] } });
  });

  it('a link to a missing row names the field; a row in use cannot be removed', () => {
    const missing = new ForeignKeyConstraintError({ parent: pg({ detail: 'Key (accountGroupId)=(99) is not present in table "AccountGroups".' }) } as never);
    expect(body(missing)).toEqual({ message: 'Please fix the highlighted fields', errors: { accountGroupId: ['The chosen account group does not exist'] } });
    const inUse = new ForeignKeyConstraintError({ parent: pg({ detail: 'Key (id)=(5) is still referenced from table "Charges".', table: 'Charges' }) } as never);
    expect(databaseErrorAnswer(inUse)).toBeInstanceOf(ConflictException);
  });

  it('required, too long and badly formed values are field errors; a timeout and a deadlock say what to do', () => {
    const db = (code: string, column?: string) => new DatabaseError(pg({ code, column, sql: 'x' }) as never);
    expect(body(db('23502', 'hsnCode'))).toMatchObject({ errors: { hsnCode: ['Hsn code is required'] } });
    expect(body(db('22001', 'name'))).toMatchObject({ errors: { name: ['Name is too long'] } });
    expect(body(db('22P02'))).toMatchObject({ errors: { Error: ['A value is not in the right format'] } });
    expect(databaseErrorAnswer(db('57014'))).toBeInstanceOf(ServiceUnavailableException);
    expect(databaseErrorAnswer(db('40P01'))).toBeInstanceOf(ConflictException);
    expect(body(new ValidationError('x', [new (ValidationErrorItem as unknown as new (...args: unknown[]) => ValidationErrorItem)('name cannot be null', 'notNull violation', 'name', null)]))).toMatchObject({ errors: { name: ['name cannot be null'] } });
  });

  it('anything else is a 500 with a reference only; an HttpException passes as thrown', () => {
    const answers: Array<{ status: number; json: unknown }> = [];
    const res = { headersSent: false, status: (status: number) => ({ json: (json: unknown) => answers.push({ status, json }) }) };
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as never;
    const filter = new ErrorAnswerFilter();
    vi.spyOn((filter as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => undefined);
    filter.catch(new TypeError('Cannot read properties of undefined (reading secretColumn)'), host);
    filter.catch(new NotFoundException('Charge not found'), host);
    expect(answers[0]!.status).toBe(500);
    expect(JSON.stringify(answers[0]!.json)).not.toMatch(/secretColumn|TypeError/);
    expect(answers[0]!.json).toMatchObject({ statusCode: 500, reference: expect.any(String) });
    expect(answers[1]).toEqual({ status: 404, json: expect.objectContaining({ message: 'Charge not found' }) });
  });
});
