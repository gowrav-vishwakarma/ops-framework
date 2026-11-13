import { Model } from 'sequelize';

/**
 * `Model.bulkCreate` in batches. One statement per call grows without bound with the rows (a voucher of
 * thousands of lines, thousands of generated labels): slow to build, heavy on memory, and Postgres refuses
 * more than 65,535 bind parameters in one statement. Every `bulkCreate` of more than `BULK_CHUNK` rows
 * runs as several statements of at most that many rows, in order, with the same options; the answer is
 * every created row, in the order given. Pass a transaction (as every ops write does) to keep it atomic.
 */
export const BULK_CHUNK = 1000;

type BulkCreate = (this: unknown, records: readonly object[], options?: object) => Promise<unknown[]>;

/** The batching wrapper around a `bulkCreate` (pure: testable without a database). */
export function chunkedBulkCreate(original: BulkCreate, size: number = BULK_CHUNK): BulkCreate {
  return async function (this: unknown, records, options) {
    if (!Array.isArray(records) || records.length <= size) return original.call(this, records, options);
    const created: unknown[] = [];
    for (let i = 0; i < records.length; i += size) created.push(...(await original.call(this, records.slice(i, i + size), options)));
    return created;
  };
}

let installed = false;

/** Batches every model's `bulkCreate` (once per process; the framework installs it when it binds models). */
export function installBulkCreateChunking(size: number = BULK_CHUNK): void {
  if (installed) return;
  installed = true;
  const target = Model as unknown as { bulkCreate: BulkCreate };
  target.bulkCreate = chunkedBulkCreate(target.bulkCreate, size);
}
