import { Redis } from 'ioredis';

/** A Redis connection for the framework. Blocking reads and subscriptions each need their own. */
export function redisConnection(url: string, name: string): Redis {
  return new Redis(url, { connectionName: `ops-${name}`, maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}
