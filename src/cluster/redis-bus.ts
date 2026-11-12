import type { Redis } from 'ioredis';
import { ClusterBus } from './cluster-bus.js';
import { redisConnection } from './redis.js';

const CHANNEL = 'ops:bus';

/**
 * The cluster bus over Redis pub/sub: every process of the deployment receives every message,
 * within milliseconds. Pub/sub keeps nothing for a disconnected process; the caches it serves have
 * a TTL for that.
 */
export class RedisBus extends ClusterBus {
  readonly distributed = true;
  readonly settleMs = 1_000;
  private readonly pub: Redis;
  private readonly sub: Redis;

  constructor(url: string) {
    super();
    this.pub = redisConnection(url, 'bus-pub');
    this.sub = redisConnection(url, 'bus-sub');
    void this.sub.subscribe(CHANNEL);
    this.sub.on('message', (_channel: string, raw: string) => {
      try {
        const { topic, payload } = JSON.parse(raw) as { topic: string; payload: unknown };
        void this.deliver(topic, payload);
      } catch {
        this.logger.warn('Unreadable bus message');
      }
    });
  }

  async publish<T>(topic: string, payload: T): Promise<void> {
    await this.pub.publish(CHANNEL, JSON.stringify({ topic, payload }));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    this.sub.disconnect();
    this.pub.disconnect();
  }
}
