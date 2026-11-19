import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';

/** The comment every query of request `id` starts with. */
export function queryTag(id: string): string {
  return `/* r:${id} */ `;
}

/**
 * Cancels the running statements tagged with request `id`, on another connection of the pool (never the request's
 * own, which is busy running them). By tag, not by process id: behind a pooler (RDS Proxy) the app never sees the
 * server process of its connection. The request id is hex, so the pattern has no LIKE wildcards of its own.
 */
export const CANCEL_TAGGED_SQL = "SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE state = 'active' AND query LIKE $1 AND pid <> pg_backend_pid()";

export function cancelPattern(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Bad request id: ${id}`);
  return `${queryTag(id).trimEnd()}%`;
}

/** How many statements of request `id` were cancelled on `sequelize`. */
export async function cancelTagged(sequelize: Sequelize, id: string): Promise<number> {
  const rows = await sequelize.query<{ cancelled: boolean }>(CANCEL_TAGGED_SQL, { bind: [cancelPattern(id)], type: QueryTypes.SELECT });
  return rows.filter((row) => row.cancelled).length;
}
