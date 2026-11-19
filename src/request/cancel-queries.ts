import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';

/** Who sent a statement, besides its request: the company, and the operation and step file running it. */
export interface QuerySource {
  companyId?: number | null;
  /** `<Model>.<operation>` (`Payment.create`). */
  op?: string;
  /** The step file (`save/510-after-post-ledger.ts`). */
  step?: string;
}

/** A value inside the comment: never `*\/` (it would end the comment early and change the statement). */
const safe = (value: string | number) => String(value).replace(/\*\//g, '* /');

/**
 * The comment every statement of request `id` starts with: `/* r:<id> c:<company> op:<Model.op> step:<file> *\/`, the
 * request first (the cancel matches it by prefix), then who sent it as far as known (op and step only inside a step).
 */
export function queryTag(id: string, source: QuerySource = {}): string {
  const parts = [`r:${safe(id)}`];
  if (source.companyId) parts.push(`c:${safe(source.companyId)}`);
  if (source.op) parts.push(`op:${safe(source.op)}`);
  if (source.step) parts.push(`step:${safe(source.step)}`);
  return `/* ${parts.join(' ')} */ `;
}

/**
 * Cancels the running statements tagged with request `id`, on another connection of the pool (never the request's
 * own, which is busy running them). By tag, not by process id: behind a pooler (RDS Proxy) the app never sees the
 * server process of its connection. The request id is hex (no LIKE wildcards of its own), followed by a space: another id that starts the same never
 * matches.
 */
export const CANCEL_TAGGED_SQL = "SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE state = 'active' AND query LIKE $1 AND pid <> pg_backend_pid()";

export function cancelPattern(id: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error(`Bad request id: ${id}`);
  return `/* r:${id} %`;
}

/** How many statements of request `id` were cancelled on `sequelize`. */
export async function cancelTagged(sequelize: Sequelize, id: string): Promise<number> {
  const rows = await sequelize.query<{ cancelled: boolean }>(CANCEL_TAGGED_SQL, { bind: [cancelPattern(id)], type: QueryTypes.SELECT });
  return rows.filter((row) => row.cancelled).length;
}
