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
