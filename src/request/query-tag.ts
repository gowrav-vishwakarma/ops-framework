import { queryTag } from './cancel-queries.js';
import { currentWork, type RequestWork } from './request-work.js';

/** A pg client's `query(text | config, values?, callback?)`. */
type ClientQuery = (config: unknown, ...rest: unknown[]) => unknown;
type PgClient = { query: ClientQuery };

const WRAPPED = Symbol('framework.queryTag');

/** Statements that end a transaction's work: still sent after an abort, so the connection goes back clean. */
const ROLLBACK = /^\s*ROLLBACK\b/i;
/** A transaction's first statement: the slot's time left goes with it as its statement timeout. */
const START = /^\s*(START\s+TRANSACTION|BEGIN)\b/i;

/** Raised instead of sending a query once its request was aborted; the request's answer is the abort reason. */
export class RequestAbortedError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : 'The request was stopped');
    this.name = 'RequestAbortedError';
  }
}

/**
 * The text a request's statement is sent as: its tag first (`/* r:<id> *\/`, so it can be cancelled by tag), and a
 * transaction's start with `SET LOCAL statement_timeout` to the slot's time left (the database's own net; `LOCAL`
 * ends with the transaction, so a pooled connection is never pinned or changed for the next request).
 */
export function taggedText(sql: string, work: RequestWork): string {
  const remaining = START.test(sql) ? work.remainingMs() : null;
  const text = remaining === null ? sql : `${sql.replace(/;\s*$/, '')}; SET LOCAL statement_timeout = ${Math.ceil(remaining)}`;
  return `${queryTag(work.id)}${text}`;
}

/**
 * Wraps a pooled pg client's `query` once: inside an HTTP request every statement is tagged with the request id and
 * counted while it runs; once the request is aborted, a new statement is refused (a rollback still goes). Sequelize
 * has already looked at the SQL by then, so the tag changes nothing it decides from the text. Outside a request the
 * client is untouched.
 */
export function tagRequestQueries(client: unknown): void {
  const pg = client as PgClient | null;
  if (!pg || typeof pg.query !== 'function' || (pg as unknown as Record<symbol, boolean>)[WRAPPED]) return;
  const send = pg.query.bind(pg) as ClientQuery;
  (pg as unknown as Record<symbol, boolean>)[WRAPPED] = true;
  pg.query = (config: unknown, ...rest: unknown[]) => {
    const work = currentWork();
    const text = typeof config === 'string' ? config : typeof (config as { text?: unknown } | null)?.text === 'string' ? (config as { text: string }).text : null;
    if (!work || text === null) return send(config, ...rest);
    const callback = typeof rest[rest.length - 1] === 'function' ? (rest.pop() as (error: unknown, result?: unknown) => void) : undefined;
    if (work.signal.aborted && !ROLLBACK.test(text)) {
      const refused = new RequestAbortedError(work.signal.reason);
      if (callback) {
        process.nextTick(() => callback(refused));
        return undefined;
      }
      return Promise.reject(refused);
    }
    const tagged = typeof config === 'string' ? taggedText(text, work) : { ...(config as object), text: taggedText(text, work) };
    work.inFlight++;
    let done = false;
    const settle = () => {
      if (!done) work.inFlight--;
      done = true;
    };
    if (callback) {
      return send(tagged, ...rest, (error: unknown, result?: unknown) => {
        settle();
        callback(error, result);
      });
    }
    const answer = send(tagged, ...rest) as Promise<unknown> | undefined;
    if (answer && typeof answer.then === 'function') return answer.finally(settle);
    settle();
    return answer;
  };
}
