import { HttpException, InternalServerErrorException } from '@nestjs/common';
import type { Caller } from './contract.js';

/** A call on the wire (and in process: the same shape, so both paths behave the same). */
export interface CallEnvelope {
  id: string;
  contract: string;
  call: string;
  input: unknown;
  key?: string;
  companyId?: number;
  caller: Caller;
}

export interface EventEnvelope {
  /** Unique per event: subscribers dedupe on it. */
  id: string;
  contract: string;
  event: string;
  payload: unknown;
  companyId?: number;
  caller: Caller;
  /** ISO time the event was recorded. */
  at: string;
}

export type CallReply = { ok: true; result: unknown } | { ok: false; status: number; body: unknown };

/** What crosses back to the caller: an HTTP error as it is, anything else as a plain 500. */
export function replyOf(error: unknown): CallReply {
  if (error instanceof HttpException) return { ok: false, status: error.getStatus(), body: error.getResponse() };
  return { ok: false, status: 500, body: new InternalServerErrorException().getResponse() };
}

export function errorOf(reply: Extract<CallReply, { ok: false }>): HttpException {
  return new HttpException(reply.body as Record<string, unknown>, reply.status);
}

/** Results cross as JSON in every deployment, so nobody relies on getting a model instance back. */
export function plain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
