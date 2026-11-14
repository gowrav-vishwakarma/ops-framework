import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * Logs a Redis connection's errors once per outage (ioredis reconnects by itself): without a listener ioredis prints
 * "Unhandled error event" for every failed attempt. Logged again when it is back.
 */
export function quietRedisErrors(client: Redis, name: string, logger = new Logger('Redis')): Redis {
  let down = false;
  client.on('error', (error: Error) => {
    if (down) return;
    down = true;
    logger.warn(`Redis connection ${name} lost (${error.message}); retrying`);
  });
  client.on('ready', () => {
    if (!down) return;
    down = false;
    logger.log(`Redis connection ${name} back`);
  });
  return client;
}

/** A Redis connection for the framework. Blocking reads and subscriptions each need their own. */
export function redisConnection(url: string, name: string): Redis {
  return quietRedisErrors(new Redis(url, { connectionName: `ops-${name}`, maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false }), `ops-${name}`);
}
