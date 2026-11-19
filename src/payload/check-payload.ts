import { Logger, type Type } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { flattenValidationErrors, payloadErrors, type FieldErrors } from '../errors.js';

/**
 * How strictly request payloads are held to their DTO (`payloads.strict` in the framework options; default `error`):
 * - `off`: unknown fields are dropped silently (the old whitelist behaviour);
 * - `warn`: unknown fields are dropped and reported (logged once per endpoint and field, counted in `payloadWarnings()`),
 *   so a deployment shows which client sends what before the switch;
 * - `error`: unknown fields are refused like any other wrong field.
 * Missing, mistyped or out-of-range fields are refused in every mode.
 */
export type PayloadStrictness = 'off' | 'warn' | 'error';

export interface PayloadCheck {
  /** `POST /sales-invoices`: names the endpoint in warnings. */
  endpoint: string;
  mode: PayloadStrictness;
  /** Turns field errors into the app's refusal (default: `payloadErrors`, 400: the request is malformed against its contract). */
  refuse?: (errors: FieldErrors) => Error;
}

const logger = new Logger('Payloads');
/**
 * The payload of an action that takes nothing (activate, deactivate): `input: NoPayload`. Strict, anything sent is an
 * unknown field; the contract shows the action without a body.
 */
export class NoPayload {}

/** endpoint → field (array positions as `*`) → times seen. */
const seen = new Map<string, Map<string, number>>();

/** The unknown fields each endpoint received since the process started (`warn` and `error` modes). */
export function payloadWarnings(): Array<{ endpoint: string; field: string; count: number }> {
  return [...seen].flatMap(([endpoint, fields]) => [...fields].map(([field, count]) => ({ endpoint, field, count }))).sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.field.localeCompare(b.field));
}

/** Clears the warnings (tests). */
export function resetPayloadWarnings(): void {
  seen.clear();
}

/** Reports unknown fields an endpoint received (once in the log per field, counted in `payloadWarnings()`). */
export function reportUnknownFields(endpoint: string, fields: string[]): void {
  note(endpoint, fields);
}

function note(endpoint: string, fields: string[]): void {
  let known = seen.get(endpoint);
  if (!known) seen.set(endpoint, (known = new Map()));
  const fresh = fields.filter((f) => !known.has(f));
  for (const field of fields) known.set(field, (known.get(field) ?? 0) + 1);
  if (fresh.length) logger.warn(`${endpoint}: unknown field${fresh.length === 1 ? '' : 's'} ${fresh.join(', ')}`);
}

/**
 * A payload held to its DTO class: the class instance (converted types, unknown fields gone) and the fields it gets
 * wrong (none when it may pass). Unknown fields, nested ones included (`lines.0.foo`), are class-validator's whitelist
 * errors: reported (`warn`, `error`) and, in `error`, wrong like any other.
 */
export function payloadProblems<T extends object>(dto: Type<T>, payload: unknown, check: Omit<PayloadCheck, 'refuse'>): { instance: T; errors: FieldErrors } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { instance: {} as T, errors: { body: ['must be an object'] } };
  const instance = plainToInstance(dto, payload, { enableImplicitConversion: true }) as T;
  const found = flattenValidationErrors(validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: false }));
  const unknown: string[] = [];
  const errors: FieldErrors = {};
  for (const [field, messages] of Object.entries(found)) {
    if (isUnknown(messages)) unknown.push(field);
    else errors[field] = messages;
  }
  if (unknown.length && check.mode !== 'off') note(check.endpoint, [...new Set(unknown.map((f) => f.replace(/\.\d+(?=\.|$)/g, '.*')))]);
  if (check.mode === 'error') for (const field of unknown) errors[field] = [`${field.split('.').pop()} is not a field of this payload`];
  // Drops the unknown fields (validated again with the plain whitelist: it strips in place).
  if (unknown.length && !Object.keys(errors).length) validateSync(instance, { whitelist: true, forbidUnknownValues: false });
  return { instance, errors };
}

/** `payloadProblems`, refused (`check.refuse`, default 400 `payloadErrors`) when any field is wrong. */
export function checkPayload<T extends object>(dto: Type<T>, payload: unknown, check: PayloadCheck): T {
  const { instance, errors } = payloadProblems(dto, payload, check);
  if (Object.keys(errors).length) throw (check.refuse ?? ((e: FieldErrors) => payloadErrors(e)))(errors);
  return instance;
}

/** class-validator reports an unknown property as one `whitelistValidation` message: "property x should not exist". */
const isUnknown = (messages: string[]) => messages.length === 1 && /^property .+ should not exist$/.test(messages[0]!);
