import { describe, expect, it, vi } from 'vitest';
import { ClusterBus, LocalBus } from '../cluster/cluster-bus.js';
import { PlacementResolver } from './placement.js';

const options = (cacheMs: number) => ({ tenancy: { placement: { strategy: 'routed', cacheMs } } }) as never;

function resolver(bus: ClusterBus, cacheMs = 30_000) {
  const rows = { findOne: vi.fn(async () => ({ companyId: 7, dbKey: 'primary', schema: 's', epoch: 1, status: 'active' as const })) };
  const store = { route: rows.findOne, activeRoutes: async () => [], shard: async () => null };
  const placements = new PlacementResolver(options(cacheMs), store, bus);
  placements.onModuleInit();
  return { placements, rows };
}

class FakeRedisBus extends ClusterBus {
  readonly distributed = true;
  readonly settleMs = 5;
  async publish<T>(topic: string, payload: T): Promise<void> {
    await this.deliver(topic, payload);
  }
}

describe('placement cache across processes', () => {
  it('a broadcast from another process drops the cached route', async () => {
    const bus = new LocalBus();
    const { placements, rows } = resolver(bus);
    await placements.resolve({ companyId: 7 });
    await placements.resolve({ companyId: 7 });
    expect(rows.findOne).toHaveBeenCalledTimes(1);
    await bus.publish('framework.placement', { companyId: 7 });
    await placements.resolve({ companyId: 7 });
    expect(rows.findOne).toHaveBeenCalledTimes(2);
  });

  it('changed() waits the cache TTL when the bus cannot reach other processes', async () => {
    vi.useFakeTimers();
    try {
      const { placements } = resolver(new LocalBus(), 30_000);
      let done = false;
      const waiting = placements.changed(7).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await waiting;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('changed() waits only the bus settle time when the bus is distributed', async () => {
    const { placements } = resolver(new FakeRedisBus(), 30_000);
    const started = Date.now();
    await placements.changed(7);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
