import { createRequire } from 'node:module';
import { currentTenant } from '../tenancy/context.js';
import { queryTag } from './cancel-queries.js';
import { currentWork, type RequestWork } from './request-work.js';

/** Sequelize's Postgres `Query.run(sql, parameters)`: every statement of every pool goes through it. */
type QueryRun = (this: unknown, sql: string, parameters?: unknown) => Promise<unknown>;
export type RunnableQuery = { prototype: { run: QueryRun } };

const PATCHED = Symbol('framework.queryTag');

/** Statements that end a transaction's work: still sent after an abort, so the connection goes back clean. */
const ROLLBACK = /^\s*ROLLBACK\b/i;
/** A transaction's first statement: the slot's time left goes with it as its statement timeout. */
const START = /^\s*(START\s+TRANSACTION|BEGIN)\b/i;

/** Raised instead of sending a statement once its request was aborted; the request's answer is the abort reason. */
export class RequestAbortedError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : 'The request was stopped');
    this.name = 'RequestAbortedError';
  }
}

/**
 * The text a request's statement is sent as: its tag first (request, company, operation and step), and a transaction's
 * start with `SET LOCAL statement_timeout` to the slot's time left (the database's own net; `LOCAL` ends with the
 * transaction, so a pooled connection is never pinned or changed for the next request).
 */
export function taggedText(sql: string, work: RequestWork, companyId?: number | null): string {
  const remaining = START.test(sql) ? work.remainingMs() : null;
  const text = remaining === null ? sql : `${sql.replace(/;\s*$/, '')}; SET LOCAL statement_timeout = ${Math.ceil(remaining)}`;
  return `${queryTag(work.id, { companyId, ...work.at })}${text}`;
}

/** Sequelize's Postgres query class (the app's own Sequelize: a peer dependency). */
function postgresQuery(): RunnableQuery {
  return createRequire(import.meta.url)('sequelize/lib/dialects/postgres/query') as RunnableQuery;
}

/**
 * Patches Sequelize's Postgres `Query.prototype.run` once per process (as classic does for its SQL comments):
 * Sequelize 6 has no hook that can change a statement's text, and the tag must be in the text to reach
 * `pg_stat_activity` through RDS Proxy. Inside an HTTP request every statement is tagged and counted while it runs;
 * once the request is aborted a new statement is refused (a rollback still goes). Outside a request it goes as it is.
 */
export function installQueryTag(target: RunnableQuery = postgresQuery()): void {
  const proto = target.prototype as RunnableQuery['prototype'] & Record<symbol, boolean>;
  if (proto[PATCHED]) return;
  const run = proto.run;
  proto.run = function (this: unknown, sql: string, parameters?: unknown) {
    const work = currentWork();
    if (!work) return run.call(this, sql, parameters);
    if (work.signal.aborted && !ROLLBACK.test(sql)) return Promise.reject(new RequestAbortedError(work.signal.reason));
    work.inFlight++;
    return run.call(this, taggedText(sql, work, currentTenant()?.ref.companyId), parameters).finally(() => work.inFlight--);
  };
  proto[PATCHED] = true;
}
