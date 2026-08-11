import { getRedis } from '../config/redis';
import { logger } from '../utils/logger';

/**
 * Redis cache for the per-user chat context snapshot (see chat.service.ts).
 *
 * Kept in its own module — with no service imports — so any write path that
 * changes a user's data (scan completion, comfort log, break-plan edit) can
 * invalidate the cache WITHOUT creating an import cycle back through
 * chat.service (which itself imports coach.service).
 */

// The snapshot is stable within a short window, so cache it to skip the ~9 DB
// queries per chat turn. Short TTL bounds staleness even without invalidation.
export const CONTEXT_TTL_SEC = 120;

export const contextKey = (userId: string) => `chat:ctx:${userId}`;

/**
 * Purge all Redis state tied to a user (cached context + per-day chat quota
 * counters). Called from the GDPR account-deletion cascade so nothing user-keyed
 * lingers in Redis. Both key sets are TTL-bounded, so this FAILS OPEN: a Redis
 * error is logged, not thrown — the DB cascade must still complete.
 */
export async function purgeUserChatData(userId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(contextKey(userId));
    // Quota keys are `chat:quota:<userId>:<dayKey>` — one per active local day.
    // SCAN (non-blocking) + delete this user's matches.
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `chat:quota:${userId}:*`,
        'COUNT',
        100,
      );
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    logger.warn('Chat data purge on account deletion failed — TTL will expire it', err);
  }
}

/**
 * Drop a user's cached chat context so the next message rebuilds it fresh.
 * Call after an event that changes their data for instant freshness — optional,
 * since the TTL expires it anyway. FAILS OPEN: a Redis error is logged, not thrown.
 */
export async function invalidateChatContext(userId: string): Promise<void> {
  try {
    await getRedis().del(contextKey(userId));
  } catch (err) {
    logger.warn('Chat context invalidation failed — TTL will expire it', err);
  }
}
