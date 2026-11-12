import { AsyncLocalStorage } from 'node:async_hooks';

/** The queries one request sent, on every pool (primary, control, shards). */
export interface QueryStats {
  queries: number;
}

const storage = new AsyncLocalStorage<QueryStats>();

/** Runs `work` (the rest of a request) with a fresh counter. */
export function withQueryStats<T>(work: () => T): T {
  return storage.run({ queries: 0 }, work);
}

/** Counted by the query guard for every statement. */
export function countQuery(): void {
  const stats = storage.getStore();
  if (stats) stats.queries++;
}

/** The running request's counter, if it is counted. */
export function currentQueryStats(): QueryStats | undefined {
  return storage.getStore();
}
