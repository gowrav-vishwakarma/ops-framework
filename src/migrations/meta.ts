import { QueryTypes, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { quoteIdent } from '../tenancy/context.js';

/** One per schema: which migrations it has. Lives beside the tables it describes, so it moves with them. */
export const META_TABLE = 'framework_migrations';

const meta = (schema: string) => `${quoteIdent(schema)}.${quoteIdent(META_TABLE)}`;

export async function hasMeta(sequelize: Sequelize, schema: string, t?: Transaction): Promise<boolean> {
  const rows = await sequelize.query('SELECT 1 FROM information_schema.tables WHERE table_schema = :schema AND table_name = :table', {
    replacements: { schema, table: META_TABLE },
    type: QueryTypes.SELECT,
    transaction: t,
  });
  return rows.length > 0;
}

export async function ensureMeta(sequelize: Sequelize, schema: string, t?: Transaction): Promise<void> {
  await sequelize.query(`CREATE TABLE IF NOT EXISTS ${meta(schema)} (name varchar(200) PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`, { transaction: t });
}

export async function appliedNames(sequelize: Sequelize, schema: string, t?: Transaction): Promise<Set<string>> {
  if (!(await hasMeta(sequelize, schema, t))) return new Set();
  const rows = await sequelize.query<{ name: string }>(`SELECT name FROM ${meta(schema)}`, { type: QueryTypes.SELECT, transaction: t });
  return new Set(rows.map((row) => row.name));
}

export async function recordApplied(sequelize: Sequelize, schema: string, names: string[], t?: Transaction): Promise<void> {
  if (names.length === 0) return;
  await sequelize.query(`INSERT INTO ${meta(schema)} (name) SELECT unnest(ARRAY[:names]::varchar[]) ON CONFLICT DO NOTHING`, { replacements: { names }, transaction: t });
}

export async function forget(sequelize: Sequelize, schema: string, name: string, t?: Transaction): Promise<void> {
  await sequelize.query(`DELETE FROM ${meta(schema)} WHERE name = :name`, { replacements: { name }, transaction: t });
}

/** Serialises migration runners on one schema across processes, until `t` ends. */
export async function lockSchema(sequelize: Sequelize, schema: string, t: Transaction): Promise<void> {
  await sequelize.query(`SELECT pg_advisory_xact_lock(hashtext(:key))`, { replacements: { key: `framework-migrate:${schema}` }, transaction: t });
}
