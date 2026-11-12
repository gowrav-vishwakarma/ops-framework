import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { hostname } from 'node:os';
import { redisConnection } from '../cluster/redis.js';
import type { Subscription } from './dispatcher.js';
import type { EventEnvelope } from './envelope.js';
import { EventTransport, type Deliver } from './event-transport.js';

const streamOf = (contract: string) => `ops:events:${contract}`;
export const DEAD_STREAM = 'ops:events:dead';
/** Approximate cap per stream; consumers are expected to keep up. */
const MAX_LEN = 100_000;
/** A message unacknowledged this long is taken over by another consumer of its group. */
const CLAIM_IDLE_MS = 60_000;
/** After this many deliveries a message goes to the dead stream for a human to look at. */
const MAX_DELIVERIES = 10;

type Entry = [id: string, fields: string[]];

/**
 * Events over Redis Streams, one stream per contract. Each subscriber method is a consumer group,
 * so it gets every event once across all its replicas; the replicas are its consumers. A message
 * is acknowledged after the subscriber's transaction commits. One that a crashed or failing
 * consumer left unacknowledged is claimed again after `CLAIM_IDLE_MS`, and parked on
 * `ops:events:dead` after `MAX_DELIVERIES`.
 */
export class RedisStreamTransport extends EventTransport {
  readonly name = 'redis-streams';
  private readonly logger = new Logger('RedisStreams');
  private readonly writer: Redis;
  private readonly reader: Redis;
  private readonly consumer = `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private running = false;
  private loop: Promise<void> | null = null;

  private readonly pollMs: number;
  private readonly claimIdleMs: number;

  constructor(url: string, options: { pollMs?: number; claimIdleMs?: number } = {}) {
    super();
    this.pollMs = options.pollMs ?? 200;
    this.claimIdleMs = options.claimIdleMs ?? CLAIM_IDLE_MS;
    this.writer = redisConnection(url, 'events-writer');
    this.reader = redisConnection(url, 'events-reader');
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    await this.writer.xadd(streamOf(envelope.contract), 'MAXLEN', '~', MAX_LEN, '*', 'e', JSON.stringify(envelope));
  }

  async start(subscriptions: Subscription[], deliver: Deliver): Promise<void> {
    if (subscriptions.length === 0) return;
    for (const subscription of subscriptions) {
      await this.writer.xgroup('CREATE', streamOf(subscription.contract.name), subscription.id, '$', 'MKSTREAM').catch((error: Error) => {
        if (!error.message.includes('BUSYGROUP')) throw error;
      });
    }
    this.running = true;
    this.loop = this.run(subscriptions, deliver);
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => undefined);
    this.reader.disconnect();
    this.writer.disconnect();
  }

  private async run(subscriptions: Subscription[], deliver: Deliver): Promise<void> {
    let lastClaim = 0;
    while (this.running) {
      let handled = 0;
      try {
        const claim = Date.now() - lastClaim > this.claimIdleMs / 2;
        if (claim) lastClaim = Date.now();
        for (const subscription of subscriptions) {
          if (claim) handled += await this.reclaim(subscription, deliver);
          const reply = (await this.reader.xreadgroup('GROUP', subscription.id, this.consumer, 'COUNT', 50, 'STREAMS', streamOf(subscription.contract.name), '>')) as Array<[string, Entry[]]> | null;
          for (const [, entries] of reply ?? []) for (const entry of entries) handled += await this.handle(subscription, entry, deliver);
        }
      } catch (error) {
        if (this.running) this.logger.error(`Event loop: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (handled === 0 && this.running) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /** Takes over messages another consumer of the group left unacknowledged. */
  private async reclaim(subscription: Subscription, deliver: Deliver): Promise<number> {
    const stream = streamOf(subscription.contract.name);
    const [, entries] = (await this.reader.xautoclaim(stream, subscription.id, this.consumer, this.claimIdleMs, '0-0', 'COUNT', 50)) as [string, Entry[]];
    let handled = 0;
    for (const entry of entries) {
      const pending = (await this.reader.xpending(stream, subscription.id, entry[0], entry[0], 1)) as Array<[string, string, number, number]>;
      if ((pending[0]?.[3] ?? 0) > MAX_DELIVERIES) {
        await this.writer.xadd(DEAD_STREAM, 'MAXLEN', '~', MAX_LEN, '*', 'group', subscription.id, 'stream', stream, 'e', entry[1][1] ?? '');
        await this.reader.xack(stream, subscription.id, entry[0]);
        this.logger.error(`Event ${entry[0]} for ${subscription.id} parked on ${DEAD_STREAM} after ${MAX_DELIVERIES} deliveries`);
        continue;
      }
      handled += await this.handle(subscription, entry, deliver);
    }
    return handled;
  }

  private async handle(subscription: Subscription, [id, fields]: Entry, deliver: Deliver): Promise<number> {
    const envelope = JSON.parse(fields[1] ?? '{}') as EventEnvelope;
    if (envelope.event !== subscription.event) {
      await this.reader.xack(streamOf(subscription.contract.name), subscription.id, id);
      return 0;
    }
    try {
      await deliver(subscription, envelope);
      await this.reader.xack(streamOf(subscription.contract.name), subscription.id, id);
    } catch (error) {
      this.logger.warn(`${subscription.id} failed on ${envelope.contract}.${envelope.event} ${envelope.id}; retried later: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}
