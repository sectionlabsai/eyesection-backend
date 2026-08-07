import IORedis, { Redis } from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

/**
 * Shared Redis connection for rate limiting and general use.
 *
 * BullMQ (EB-04) requires its own connection options (maxRetriesPerRequest:null),
 * so the queue creates a dedicated client — see src/config/queue.ts.
 */
let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  client.on('error', (err) => logger.error('Redis error', err));
  client.on('connect', () => logger.info('Redis connected'));
  return client;
}

/**
 * Readiness probe for Redis — returns true only if the server answers PING.
 * Never throws; a failure resolves to false so /ready can report it and the
 * load balancer routes elsewhere. Bounded so a hung socket can't stall /ready.
 */
export async function pingRedis(): Promise<boolean> {
  try {
    const pong = await Promise.race([
      getRedis().ping(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('redis ping timeout')), 2000),
      ),
    ]);
    return pong === 'PONG';
  } catch (err) {
    logger.warn('Redis readiness ping failed', err);
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
