import type { Transaction } from 'sequelize';
import { requireTenant, quoteIdent } from './context.js';
import { inheritMark, markTx, sequelizeOf } from './guards.js';

/**
 * A transaction on the current tenant's shard with `search_path` set to its schema, so raw SQL in
 * it needs no schema prefix and nothing leaks to the next user of the pooled connection
 * (`SET LOCAL` ends with the transaction). Every tenant write goes through here.
 */
export function tenantTransaction<T>(work: (t: Transaction) => Promise<T>): Promise<T> {
  const tenant = requireTenant('a tenant transaction');
  return tenant.sequelize.transaction(async (t) => {
    markTx(t, { kind: 'tenant', dbKey: tenant.placement.dbKey });
    await tenant.sequelize.query(`SET LOCAL search_path TO ${quoteIdent(tenant.placement.schema)}`, { transaction: t });
    return work(t);
  });
}

/** A savepoint of `t`: if `work` throws, only its part is rolled back. */
export function tenantSavepoint<T>(t: Transaction, work: (t: Transaction) => Promise<T>): Promise<T> {
  return sequelizeOf(t).transaction({ transaction: t }, (nested: Transaction) => work(inheritMark(t, nested)));
}
