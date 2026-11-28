import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A Redis as the transport uses it: streams with consumer groups. `lose()` drops every stream and group, as a Redis
 * restart without persistence (or an eviction) does; reads of a lost group answer NOGROUP until it is created again.
 */
const redis = vi.hoisted(() => {
  type Stream = { entries: Array<[string, string[]]>; groups: Map<string, number> };
  const streams = new Map<string, Stream>();
  let seq = 0;
  const noGroup = (stream: string, group: string) => new Error(`NOGROUP No such key '${stream}' or consumer group '${group}' in XREADGROUP with GROUP option`);
  const connection = {
    async xgroup(_cmd: string, stream: string, group: string, from: string, _mk: string) {
      const s: Stream = streams.get(stream) ?? { entries: [], groups: new Map() };
      streams.set(stream, s);
      if (s.groups.has(group)) throw new Error('BUSYGROUP Consumer Group name already exists');
      s.groups.set(group, from === '$' ? s.entries.length : 0);
      return 'OK';
    },
    async xadd(stream: string, ...args: unknown[]) {
      const s: Stream = streams.get(stream) ?? { entries: [], groups: new Map() };
      streams.set(stream, s);
      const id = `${++seq}-0`;
      s.entries.push([id, ['e', String(args[args.length - 1])]]);
      return id;
    },
    async xreadgroup(_g: string, group: string, _consumer: string, _c: string, _n: number, _s: string, stream: string) {
      const s = streams.get(stream);
      if (!s?.groups.has(group)) throw noGroup(stream, group);
      const at = s.groups.get(group)!;
      const fresh = s.entries.slice(at);
      s.groups.set(group, s.entries.length);
      return fresh.length ? [[stream, fresh]] : null;
    },
    async xautoclaim(stream: string, group: string) {
      if (!streams.get(stream)?.groups.has(group)) throw noGroup(stream, group);
      return ['0-0', []];
    },
    async xack() {
      return 1;
    },
    async xpending() {
      return [];
    },
    disconnect() {},
  };
  return { connection, lose: () => streams.clear() };
});
vi.mock('../cluster/redis.js', () => ({ redisConnection: () => redis.connection }));

import { RedisStreamTransport } from './redis-stream-transport.js';

const subscription = { id: 'trips.notify', event: 'trip.started', contract: { name: 'trips' } } as never;
const envelope = (id: string) => ({ id, contract: 'trips', event: 'trip.started', data: {} }) as never;
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('Redis streams transport', () => {
  let transport: RedisStreamTransport | null = null;
  afterEach(async () => {
    await transport?.stop();
    transport = null;
  });

  it('delivers again after Redis lost the stream and its group (restart without persistence, eviction)', async () => {
    const delivered: string[] = [];
    transport = new RedisStreamTransport('redis://test', { pollMs: 5 });
    await transport.start([subscription], async (_s, e) => {
      delivered.push((e as { id: string }).id);
    });
    await transport.publish(envelope('before'));
    await until(() => delivered.length === 1);

    redis.lose();
    // Published after the loss, before the group is back: delivered too (nothing in the new stream was read yet).
    await transport.publish(envelope('after'));
    await until(() => delivered.length === 2);
    expect(delivered).toEqual(['before', 'after']);
  });
});
