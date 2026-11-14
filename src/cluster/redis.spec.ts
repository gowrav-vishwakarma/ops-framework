import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { quietRedisErrors } from './redis.js';

describe('quietRedisErrors', () => {
  it('logs one warning per outage and once when back, never an unhandled error', () => {
    const client = new EventEmitter();
    const logged: string[] = [];
    quietRedisErrors(client as unknown as Redis, 'x', { warn: (m: string) => logged.push(`warn ${m}`), log: (m: string) => logged.push(`log ${m}`) } as never);
    client.emit('error', new Error('read ECONNRESET'));
    client.emit('error', new Error('connect ECONNREFUSED'));
    client.emit('ready');
    client.emit('ready');
    expect(logged).toEqual(['warn Redis connection x lost (read ECONNRESET); retrying', 'log Redis connection x back']);
  });
});
