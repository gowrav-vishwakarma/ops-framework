import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { quoteIdent } from '../context.js';
import type { Remap } from './copy-plan.js';

export type Row = Record<string, unknown>;

export const qualified = (schema: string, table: string) => `${quoteIdent(schema)}.${quoteIdent(table)}`;

/** The pg driver sends objects as JSON but arrays as SQL arrays; JSON columns need text either way. */
const bindable = (value: unknown): unknown =>
  value !== null && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) ? JSON.stringify(value) : value;

const select = <T>(sequelize: Sequelize, t: Transaction, sql: string, bind: unknown[] = []) =>
  sequelize.query(sql, { type: QueryTypes.SELECT, transaction: t, bind }) as Promise<T[]>;

/** The company's rows of one table in id order, `batch` at a time. */
export async function* readRows(sequelize: Sequelize, t: Transaction, schema: string, table: string, columns: string[], partitionColumn: string, companyId: number, keyed: boolean, batch = 2000): AsyncGenerator<Row[]> {
  const list = columns.map(quoteIdent).join(', ');
  if (!keyed) {
    // A join table has no id to page by; its rows per company are few.
    const all = await select<Row>(sequelize, t, `SELECT ${list} FROM ${qualified(schema, table)} WHERE ${quoteIdent(partitionColumn)} = $1`, [companyId]);
    if (all.length) yield all;
    return;
  }
  // No lower bound to start: ids may be UUIDs or any other ordered type, not only positive integers.
  let last: unknown;
  for (;;) {
    const after = last === undefined ? '' : ' AND id > $2';
    const rows = await select<Row>(
      sequelize, t,
      `SELECT ${list} FROM ${qualified(schema, table)} WHERE ${quoteIdent(partitionColumn)} = $1${after} ORDER BY id LIMIT ${batch}`,
      last === undefined ? [companyId] : [companyId, last],
    );
    if (rows.length === 0) return;
    yield rows;
    last = rows[rows.length - 1]?.id;
  }
}

/** Inserts rows (all with the same columns) and returns the ids Postgres gave them, in order. */
export async function insertRows(sequelize: Sequelize, t: Transaction, schema: string, table: string, rows: Row[], returnIds = true): Promise<number[]> {
  if (rows.length === 0) return [];
  const columns = Object.keys(rows[0] as Row);
  const perStatement = Math.max(1, Math.floor(60_000 / columns.length));
  const ids: number[] = [];
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const values = chunk.map((_, r) => `(${columns.map((_c, c) => `$${r * columns.length + c + 1}`).join(', ')})`).join(', ');
    const bind = chunk.flatMap((row) => columns.map((column) => bindable(row[column])));
    const sql = `INSERT INTO ${qualified(schema, table)} (${columns.map(quoteIdent).join(', ')}) VALUES ${values}`;
    if (returnIds) ids.push(...(await select<{ id: number }>(sequelize, t, `${sql} RETURNING id`, bind)).map((row) => row.id));
    else await sequelize.query(sql, { transaction: t, bind });
  }
  return ids;
}

export async function count(sequelize: Sequelize, t: Transaction, schema: string, table: string, partitionColumn: string, companyId: number): Promise<number> {
  const [row] = await select<{ n: number }>(sequelize, t, `SELECT count(*)::int AS n FROM ${qualified(schema, table)} WHERE ${quoteIdent(partitionColumn)} = $1`, [companyId]);
  return row?.n ?? 0;
}

/** Sets self-referencing columns after the table's id map exists: `links` are `[newId, oldParentId]`. */
export async function linkSelf(sequelize: Sequelize, t: Transaction, schema: string, table: string, column: string, links: Array<[number, number]>): Promise<void> {
  const target = qualified(schema, table);
  for (let start = 0; start < links.length; start += 20_000) {
    const values = links.slice(start, start + 20_000).map(([id, old]) => `(${Number(id)}, ${Number(old)})`).join(', ');
    await sequelize.query(
      `UPDATE ${target} SET ${quoteIdent(column)} = (SELECT new_id FROM ${mapTable(table)} m WHERE m.old_id = v.old_id) FROM (VALUES ${values}) AS v(id, old_id) WHERE ${target}.id = v.id`,
      { transaction: t },
    );
  }
}

/** Self references of a table whose ids were kept: each row's column set back to its old parent (same id). */
export async function linkSelfKept(sequelize: Sequelize, t: Transaction, schema: string, table: string, column: string, idType: string, links: Array<[unknown, unknown]>): Promise<void> {
  const target = qualified(schema, table);
  const type = /^[a-z ]+$/.test(idType) ? idType : 'text';
  for (let start = 0; start < links.length; start += 20_000) {
    const chunk = links.slice(start, start + 20_000);
    await sequelize.query(
      `UPDATE ${target} SET ${quoteIdent(column)} = v.parent::${type} FROM unnest($1::text[], $2::text[]) AS v(id, parent) WHERE ${target}.id = v.id::${type}`,
      { transaction: t, bind: [chunk.map(([id]) => String(id)), chunk.map(([, parent]) => String(parent))] },
    );
  }
}

const mapTable = (table: string) => `pg_temp.${quoteIdent(`_map_${table}`)}`;

/** One temp table per copied table: old id to new id. Dropped with the transaction. */
export async function storeMap(sequelize: Sequelize, t: Transaction, table: string, pairs: Array<[number, number]>): Promise<void> {
  await sequelize.query(`CREATE TEMP TABLE ${mapTable(table)} (old_id integer PRIMARY KEY, new_id integer NOT NULL) ON COMMIT DROP`, { transaction: t });
  for (let start = 0; start < pairs.length; start += 20_000) {
    const values = pairs.slice(start, start + 20_000).map(([o, n]) => `(${Number(o)}, ${Number(n)})`).join(', ');
    await sequelize.query(`INSERT INTO ${mapTable(table)} (old_id, new_id) VALUES ${values}`, { transaction: t });
  }
}

/**
 * Translates one column of the company's rows through the id maps. An id with no entry (a deleted
 * user, a deleted record) becomes NULL for ordinary references and its negative for polymorphic
 * ones, so it can never point at somebody else's row in a shared schema. `0` stays `0` where it
 * means "the system".
 */
export async function remapColumn(sequelize: Sequelize, t: Transaction, schema: string, table: string, partitionColumn: string, companyId: number, remap: Remap): Promise<void> {
  const target = qualified(schema, table);
  const column = quoteIdent(remap.column);
  const where = `${quoteIdent(partitionColumn)} = $1 AND ${column} IS NOT NULL`;
  const keep = remap.zeroIsSystem ? `CASE WHEN ${column} = 0 THEN 0 ELSE NULL END` : 'NULL';
  if (remap.polymorphic) {
    const typeColumn = quoteIdent(remap.polymorphic.typeColumn);
    for (const [type, mapped] of Object.entries(remap.polymorphic.types)) {
      await sequelize.query(
        `UPDATE ${target} SET ${column} = COALESCE((SELECT new_id FROM ${mapTable(mapped)} m WHERE m.old_id = ${target}.${column}), -${target}.${column}) WHERE ${where} AND ${typeColumn} = $2`,
        { transaction: t, bind: [companyId, type] },
      );
    }
    return;
  }
  await sequelize.query(
    `UPDATE ${target} SET ${column} = COALESCE((SELECT new_id FROM ${mapTable(remap.table as string)} m WHERE m.old_id = ${target}.${column}), ${keep}) WHERE ${where}`,
    { transaction: t, bind: [companyId] },
  );
}

export { mapTable };
