import { describe, expect, it } from 'vitest';
import { countQuery, currentQueryStats, withQueryStats } from './query-stats.js';

describe('query stats', () => {
  it('counts the queries of one request, apart from another running at the same time', async () => {
    const run = (n: number) =>
      withQueryStats(async () => {
        for (let i = 0; i < n; i++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          countQuery();
        }
        return currentQueryStats()!.queries;
      });
    expect(await Promise.all([run(3), run(7)])).toEqual([3, 7]);
  });

  it('counts nothing outside a request', () => {
    countQuery();
    expect(currentQueryStats()).toBeUndefined();
  });
});
