import type { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { QueryTypes, type Transaction } from 'sequelize';
import type { AclScope, Actor, ReqCtx } from '../auth/auth-user.js';
import { EventOutbox } from '../services/event-outbox.js';
import { ServiceClient } from '../services/service-client.js';
import { inheritMark, sequelizeOf } from '../tenancy/guards.js';
import { Issues } from './issues.js';
import type { Attrs, OpBase } from './op-context.js';

/** What differs between the tenant plane and the control plane inside an operation. */
export interface OpPlane<U extends Actor = Actor> {
  /** A new transaction on the plane, committed on its own. */
  separate<T>(work: (t: Transaction) => Promise<T>): Promise<T>;
  /** The scope the caller holds for `code`, or null. */
  can(ctx: ReqCtx<U>, code: string): Promise<AclScope | null>;
}

export interface OpBaseEnv<U extends Actor = Actor> {
  resource: string;
  moduleRef: ModuleRef;
  logger: Logger;
  plane: OpPlane<U>;
}

/** A savepoint of `t` on whatever database `t` belongs to. */
export function savepointOf<T>(t: Transaction, work: (t: Transaction) => Promise<T>): Promise<T> {
  return sequelizeOf(t).transaction({ transaction: t }, (nested: Transaction) => work(inheritMark(t, nested)));
}

/** The outermost transaction of `t` (a savepoint's parent chain). */
function rootOf(t: Transaction): Transaction {
  let top = t;
  for (let up = (top as unknown as { parent?: Transaction }).parent; up; up = (top as unknown as { parent?: Transaction }).parent) top = up;
  return top;
}

/** Counts rows in another table: `SELECT count(*) FROM <sql>`, in `t`. */
export async function countRows(t: Transaction, sql: string, replacements: Record<string, unknown>): Promise<number> {
  const rows = await sequelizeOf(t).query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, { replacements, type: QueryTypes.SELECT, transaction: t });
  return rows[0]?.n ?? 0;
}

/** A provider of the services feature, or a clear error when the project did not turn it on. */
function servicesPart<T>(env: OpBaseEnv<Actor>, token: abstract new (...args: never[]) => T): T {
  try {
    return env.moduleRef.get(token as never, { strict: false }) as T;
  } catch {
    throw new Error('c.service() and c.emit() need features.services in FrameworkModule.forRootAsync');
  }
}

/** What every kind of operation shares: who, the transaction and its helpers, services, state. */
export function makeOpBase<U extends Actor>(env: OpBaseEnv<U>, op: string, ctx: ReqCtx<U>, t: Transaction): OpBase<Attrs, U> {
  return {
    op,
    ctx,
    user: ctx.user,
    scope: ctx.scope,
    limits: ctx.limits,
    t,
    state: {},
    issues: new Issues(),
    result: undefined,
    count: (sql, replacements) => countRows(t, sql, replacements),
    sql: <T>(sql: string, replacements: Record<string, unknown> | unknown[] = {}, on: Transaction = t) =>
      sequelizeOf(on).query(sql, { replacements, type: QueryTypes.SELECT, transaction: on }) as Promise<T[]>,
    can: async (permission) => (ctx.user.id === 0 ? 'all' : env.plane.can(ctx, permission)),
    get: (token) => env.moduleRef.get(token as never, { strict: false }),
    savepoint: (work) => savepointOf(t, work),
    separate: (work) => env.plane.separate(work),
    service: (contract) => servicesPart(env, ServiceClient).for(contract),
    emit: async (contract, event, payload) => {
      await servicesPart(env, EventOutbox).emit(t, contract, event, payload);
    },
    afterCommit: (work) => {
      rootOf(t).afterCommit(async () => {
        try {
          await work();
        } catch (error) {
          env.logger.error(`afterCommit work of ${env.resource}.${op} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
    },
  };
}
