import { Injectable } from '@nestjs/common';
import { QueryTypes, type QueryOptions, type Transaction } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { requireTenant, quoteIdent } from './context.js';
import { tenantSavepoint, tenantTransaction } from './transaction.js';
import { NAMES } from '../naming.js';
import { ConnectionRegistry } from './connection-registry.js';
import { markTx, sequelizeOf } from './guards.js';

export interface TenantQueryOptions {
  replacements?: Record<string, unknown> | unknown[];
  transaction?: Transaction;
}

/**
 * The way to reach the tenant's database for anything the ORM does not do for you. ORM calls need
 * nothing: models carry the connection and schema of the request. Raw SQL goes through here (or
 * `c.t` in an operation), because the transaction pins one connection and sets `search_path`
 * with `SET LOCAL`, so a statement needs no schema prefix and cannot leak to the next request.
 */
@Injectable()
export class TenantDb {
  /** A transaction on the current tenant's shard, with `search_path` set to its schema. */
  tx<T>(work: (t: Transaction) => Promise<T>): Promise<T> {
    return tenantTransaction(work);
  }

  /** A savepoint of `t`: if `work` throws, only its part is rolled back. */
  savepoint<T>(t: Transaction, work: (t: Transaction) => Promise<T>): Promise<T> {
    return tenantSavepoint(t, work);
  }

  /** A raw query on the tenant's shard. Joins `options.transaction`, else runs in a short read transaction. */
  async query<T = Record<string, unknown>>(sql: string, options: TenantQueryOptions = {}): Promise<T[]> {
    const run = (t: Transaction) =>
      sequelizeOf(t).query(sql, { ...(options as QueryOptions), type: QueryTypes.SELECT, transaction: t }) as Promise<T[]>;
    return options.transaction ? run(options.transaction) : this.tx(run);
  }

  /** The current tenant's connection (for code that needs `QueryInterface`). */
  get sequelize(): Sequelize {
    return requireTenant('TenantDb.sequelize').sequelize;
  }
}

/** Opens a control-plane transaction (schema `platform`), refusing a tenant transaction inside it. */
@Injectable()
export class ControlPlane {
  constructor(private readonly registry: ConnectionRegistry) {}

  get sequelize(): Sequelize {
    return this.registry.control;
  }

  tx<T>(work: (t: Transaction) => Promise<T>): Promise<T> {
    const sequelize = this.registry.control;
    return sequelize.transaction(async (t) => {
      markTx(t, { kind: 'control', dbKey: this.registry.controlKey });
      await sequelize.query(`SET LOCAL search_path TO ${quoteIdent(NAMES.controlSchema)}`, { transaction: t });
      return work(t);
    });
  }

  /** A raw query on the control plane (the `platform` schema is the search path). */
  async query<T = Record<string, unknown>>(sql: string, options: TenantQueryOptions = {}): Promise<T[]> {
    const run = (t: Transaction) =>
      sequelizeOf(t).query(sql, { ...(options as QueryOptions), type: QueryTypes.SELECT, transaction: t }) as Promise<T[]>;
    return options.transaction ? run(options.transaction) : this.tx(run);
  }
}
