import { InternalServerErrorException } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { currentTenant } from './context.js';
import { NAMES } from '../naming.js';
import { isControlModel } from './model-binding.js';

/** What a transaction was opened for. Set by `TenantDb` and `ControlPlane`, read by the guards. */
export interface TxMark {
  kind: 'tenant' | 'control';
  dbKey: string;
}

const MARK = Symbol('framework.tx');

export function markTx<T extends Transaction>(t: T, mark: TxMark): T {
  (t as unknown as Record<symbol, TxMark>)[MARK] = mark;
  return t;
}

export function txMark(t: Transaction | null | undefined): TxMark | undefined {
  return t ? (t as unknown as Record<symbol, TxMark | undefined>)[MARK] : undefined;
}

/** A savepoint is a nested transaction object; it keeps the mark of its parent. */
export function inheritMark(from: Transaction, to: Transaction): Transaction {
  const mark = txMark(from);
  if (mark) markTx(to, mark);
  return to;
}

type QueryOptions = { transaction?: Transaction | null; model?: unknown; instance?: { constructor: unknown } };
type QueryLike = { sql?: string } | undefined;

function targetModel(options: QueryOptions) {
  return (options.model ?? options.instance?.constructor) as Parameters<typeof isControlModel>[0] | undefined;
}

/**
 * Two safety nets on every connection:
 * - cross-database: a tenant query must run on the connection that owns the request's `dbKey`
 *   (a transaction opened on shard A is never used on shard B);
 * - foreign transaction: a control-plane query never joins a tenant transaction and the other way
 *   round, because they may be different databases.
 */
export function installQueryGuards(sequelize: Sequelize, dbKey: string, onQuery?: () => void): void {
  sequelize.addHook('beforeQuery' as never, ((options: QueryOptions, query: QueryLike) => {
    onQuery?.();
    const mark = txMark(options.transaction);
    const model = targetModel(options);
    const control = model ? isControlModel(model) : query?.sql?.includes(`"${NAMES.controlSchema}".`) === true;

    if (mark && mark.dbKey !== dbKey) {
      throw new InternalServerErrorException(`Query on "${dbKey}" inside a transaction opened on "${mark.dbKey}"`);
    }
    if (mark?.kind === 'tenant' && model && control) {
      throw new InternalServerErrorException('A control-plane model cannot use a tenant transaction. Use c.control() or ControlPlane.tx().');
    }
    if (mark?.kind === 'control' && model && !control) {
      throw new InternalServerErrorException('A tenant model cannot use a control-plane transaction.');
    }
    const tenant = currentTenant();
    if (tenant && model && !control && tenant.placement.dbKey !== dbKey) {
      throw new InternalServerErrorException(`Tenant query on "${dbKey}" but the request's data lives on "${tenant.placement.dbKey}"`);
    }
  }) as never);
}

/** Statements that change a schema. */
const DDL = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*(CREATE|ALTER|DROP|TRUNCATE|RENAME|COMMENT\s+ON|GRANT|REVOKE)\b/i;

export class SchemaChangeRefused extends InternalServerErrorException {
  constructor(dbKey: string, sql: string) {
    super(`Refused a schema change on "${dbKey}": another system owns this schema (features.schema 'external'). Statement: ${sql.slice(0, 120)}`);
  }
}

/**
 * `features.schema: 'external'`: no statement that changes a schema ever reaches this database,
 * whoever sends it (`Model.sync()`, `sequelize.sync({ alter })`, a stray `CREATE`). Checked before
 * the query runs, on every pool.
 */
export function installDdlGuard(sequelize: Sequelize, dbKey: string): void {
  // `beforeQuery` hooks get the query before its SQL is set, so the guard wraps `query` itself:
  // models, the query interface, `sync()` and raw SQL all go through it.
  const target = sequelize as unknown as { query: (sql: unknown, options?: unknown) => Promise<unknown>; sync: () => Promise<never> };
  const query = target.query.bind(sequelize);
  target.query = (sql: unknown, options?: unknown) => {
    const text = typeof sql === 'string' ? sql : ((sql as { query?: string } | null)?.query ?? '');
    if (DDL.test(text)) return Promise.reject(new SchemaChangeRefused(dbKey, text));
    return query(sql, options);
  };
  target.sync = () => Promise.reject(new SchemaChangeRefused(dbKey, 'sync()'));
}

/** The connection a transaction belongs to (Sequelize keeps it private on the type). */
export function sequelizeOf(t: Transaction): Sequelize {
  return (t as unknown as { sequelize: Sequelize }).sequelize;
}
