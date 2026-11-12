import type { Type } from '@nestjs/common';
import type { Transaction } from 'sequelize';

/**
 * Where a service keeps its data: the control plane (identities, companies, plans) or a tenant's
 * database. A handler runs in a transaction on its plane; a tenant handler also runs in the tenant
 * context of the company the call is for.
 */
export type Plane = 'control' | 'tenant';

declare const OUT: unique symbol;

/** One call of a contract. `O` exists only for typing. */
export interface CallDef<I extends object = object, O = unknown, K extends 'command' | 'query' = 'command' | 'query'> {
  kind: K;
  /** class-validator DTO: the input is validated on the receiving side, in every deployment. */
  input: Type<I>;
  readonly [OUT]?: O;
}

export interface EventDef<P extends object = object> {
  kind: 'event';
  payload: Type<P>;
}

export type CallDefs = Record<string, CallDef<any, any, any>>;
export type EventDefs = Record<string, EventDef<any>>;

/**
 * What one service offers to the others: calls it answers and events it publishes. Every service
 * talks to another only through its contract, never through the other's models or database, so the
 * two can run in one process or in separate deployments without a code change.
 */
export interface Contract<N extends string = string, C extends CallDefs = CallDefs, E extends EventDefs = EventDefs> {
  name: N;
  plane: Plane;
  calls: C;
  events: E;
}

export function defineContract<const N extends string, C extends CallDefs = {}, E extends EventDefs = {}>(definition: {
  /** Unique, kebab-case: also the stream and endpoint name (`platform`, `tenant-sessions`). */
  name: N;
  plane: Plane;
  calls?: C;
  events?: E;
}): Contract<N, C, E> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.name)) throw new Error(`Contract name "${definition.name}" must be kebab-case`);
  return { name: definition.name, plane: definition.plane, calls: (definition.calls ?? {}) as C, events: (definition.events ?? {}) as E };
}

/** A call that changes something. Pass `key` when calling it so a retry runs it once. */
export function command<I extends object, O = void>(input: Type<I>): CallDef<I, O, 'command'> {
  return { kind: 'command', input };
}

/** A read. Safe to retry. */
export function query<I extends object, O>(input: Type<I>): CallDef<I, O, 'query'> {
  return { kind: 'query', input };
}

export function event<P extends object>(payload: Type<P>): EventDef<P> {
  return { kind: 'event', payload };
}

export type InputOf<D> = D extends CallDef<infer I, any, any> ? I : never;
export type OutputOf<D> = D extends CallDef<any, infer O, any> ? O : never;
export type PayloadOf<D> = D extends EventDef<infer P> ? P : never;
export type CommandsOf<C extends Contract> = { [K in keyof C['calls']]: C['calls'][K]['kind'] extends 'command' ? K : never }[keyof C['calls']] & string;
export type QueriesOf<C extends Contract> = { [K in keyof C['calls']]: C['calls'][K]['kind'] extends 'query' ? K : never }[keyof C['calls']] & string;
export type EventsOf<C extends Contract> = keyof C['events'] & string;

/** Who called, carried across processes. */
export interface Caller {
  /** Company of the caller's request or job, if it had one. */
  companyId?: number;
  /** Tenant user id of the caller, if a user started it. */
  userId?: number;
  requestId?: string;
}

/** What a handler receives besides the input. */
export interface CallCtx {
  contract: string;
  call: string;
  /** The company this call is for (tenant handlers: always set, and the tenant context is set). */
  companyId?: number;
  /** Idempotency key of a command, when the caller gave one. */
  key?: string;
  caller: Caller;
  /** The handler's transaction on its plane. Write with `{ transaction: t }`: the call's dedupe record commits with it. */
  t: Transaction;
}

/**
 * The class that answers a contract: one method per call, with the call's input and output types.
 * `class PlatformApi implements Handlers<typeof Platform>` makes the compiler check every method.
 */
export type Handlers<C extends Contract> = {
  [K in keyof C['calls']]: (input: InputOf<C['calls'][K]>, call: CallCtx) => Promise<OutputOf<C['calls'][K]>>;
};

/** What an event subscriber receives besides the payload. */
export interface EventCtx {
  contract: string;
  event: string;
  eventId: string;
  companyId?: number;
  caller: Caller;
  t: Transaction;
}
