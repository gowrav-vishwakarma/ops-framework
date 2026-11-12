import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { FieldErrors } from '../errors.js';

/** A reason an operation cannot go ahead, such as unpaid dues. Shown to the user as a list. */
export interface Blocker {
  code: string;
  message: string;
  /** How many rows cause it, when that is useful ("3 open trips"). */
  count?: number;
  refType?: string;
  /** The record this applies to, when a bulk action reports several at once. */
  rowId?: number;
}

/**
 * Collects every problem of one operation before failing, so the user sees all of them at once:
 * field errors (placed on form fields), blockers (hard stops) and warnings (go ahead with `confirm`).
 */
export class Issues {
  readonly fields: FieldErrors = {};
  readonly blockers: Blocker[] = [];
  readonly warnings: Blocker[] = [];

  field(name: string, message: string): this {
    (this.fields[name] ??= []).push(message);
    return this;
  }

  block(code: string, message: string, extra: Pick<Blocker, 'count' | 'refType' | 'rowId'> = {}): this {
    this.blockers.push({ code, message, ...extra });
    return this;
  }

  warn(code: string, message: string, extra: Pick<Blocker, 'count' | 'refType' | 'rowId'> = {}): this {
    this.warnings.push({ code, message, ...extra });
    return this;
  }

  get failed(): boolean {
    return Object.keys(this.fields).length > 0 || this.blockers.length > 0;
  }

  /** 422 when any field error or blocker was added. */
  throwIfFailed(message?: string): void {
    if (!this.failed) return;
    const first = this.blockers[0]?.message ?? Object.values(this.fields)[0]?.[0];
    throw new UnprocessableEntityException({
      message: message ?? first ?? 'Not allowed',
      errors: this.fields,
      blockers: this.blockers,
    });
  }

  /** 409 `needsConfirm` when there are warnings and the caller has not confirmed. */
  throwIfUnconfirmed(confirmed: boolean): void {
    if (confirmed || this.warnings.length === 0) return;
    throw new ConflictException({ message: this.warnings[0]?.message ?? 'Please confirm', warnings: this.warnings, needsConfirm: true });
  }
}
