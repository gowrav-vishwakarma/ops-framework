import { ArgumentsHost, Catch, ConflictException, HttpException, Logger, ServiceUnavailableException, type ExceptionFilter } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { BaseError, DatabaseError, ForeignKeyConstraintError, UniqueConstraintError, ValidationError } from 'sequelize';
import { fieldErrors, type FieldErrors } from './errors.js';

/** `accountGroupId` → `Account group`. */
const label = (field: string) => {
  const words = field.replace(/Id$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type PgError = { code?: string; column?: string; constraint?: string; table?: string; detail?: string };

/**
 * A database refusal as an answer the user can act on (or nothing internal, with a reference to
 * find it in the log). `null`: not a database error.
 */
export function databaseErrorAnswer(error: unknown): HttpException | null {
  if (error instanceof UniqueConstraintError) {
    const fields = Object.keys(error.fields ?? {}).filter((f) => f !== 'companyId');
    const errors: FieldErrors = {};
    for (const field of fields.length ? fields : ['Error']) errors[field] = [`${fields.length ? label(field) : 'This record'} already exists`];
    return fieldErrors(errors, 'A record with these values already exists');
  }
  if (error instanceof ForeignKeyConstraintError) {
    const pg = (error.parent ?? {}) as PgError;
    // A delete or update of a row others point at: in use. An insert pointing at a missing row: the choice is wrong.
    if (/still referenced|is still referenced/i.test(pg.detail ?? '') || /DELETE/i.test((error as { sql?: string }).sql ?? '')) {
      return new ConflictException({ message: `This record is in use${pg.table ? ` (${label(pg.table)})` : ''} and cannot be removed`, code: 'in_use' });
    }
    const field = (error.fields as string[] | undefined)?.[0] ?? /\((\w+)\)=/.exec(pg.detail ?? '')?.[1];
    return field ? fieldErrors({ [field]: [`The chosen ${label(field).toLowerCase()} does not exist`] }) : fieldErrors({ Error: ['A linked record does not exist'] });
  }
  if (error instanceof ValidationError) {
    const errors: FieldErrors = {};
    for (const item of error.errors ?? []) (errors[item.path ?? 'Error'] ??= []).push(item.message);
    return fieldErrors(Object.keys(errors).length ? errors : { Error: [error.message] });
  }
  if (error instanceof DatabaseError) {
    const pg = (error.parent ?? {}) as PgError;
    const field = pg.column ?? 'Error';
    switch (pg.code) {
      case '23502':
        return fieldErrors({ [field]: [`${label(field)} is required`] });
      case '22001':
        return fieldErrors({ [field]: [`${label(field)} is too long`] });
      case '22003':
        return fieldErrors({ [field]: [`${label(field)} is out of range`] });
      case '22P02':
      case '22007':
      case '22008':
        return fieldErrors({ [field]: [field === 'Error' ? 'A value is not in the right format' : `${label(field)} is not in the right format`] });
      case '23514':
        return fieldErrors({ Error: ['A value is not allowed here'] });
      case '57014':
        return new ServiceUnavailableException('This took too long; narrow it down and try again');
      case '40001':
      case '40P01':
        return new ConflictException('Someone else changed this at the same time; try again');
    }
  }
  return null;
}

/**
 * Every answer is either an `HttpException` as thrown, a database refusal mapped by
 * `databaseErrorAnswer`, or a plain 500 with a reference: internals (SQL, stack, messages) go to the
 * log under that reference, never to the client.
 */
@Catch()
export class ErrorAnswerFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    const known = error instanceof HttpException ? error : databaseErrorAnswer(error);
    if (known) {
      if (!(error instanceof HttpException)) this.logger.warn(`${(error as Error).name}: ${(error as Error).message}`);
      res.status(known.getStatus()).json(known.getResponse());
      return;
    }
    const reference = randomUUID().slice(0, 8);
    this.logger.error(`[${reference}] ${error instanceof BaseError || error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)}`);
    res.status(500).json({ statusCode: 500, message: `Something went wrong on our side. Reference ${reference}.`, reference });
  }
}

