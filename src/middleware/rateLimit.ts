import { NextFunction, Request, Response } from 'express';
import { getRedis } from '../config/redis';
import { AppError } from './error';
import { logger } from '../utils/logger';

interface RateLimitOptions {
  windowSec: number;
  max: number;
  keyPrefix: string;
  // What to do when Redis (the counter store) is unreachable:
  //  - true  => fail OPEN: allow the request (availability over strictness).
  //  - false => fail CLOSED: reject with 503 so an outage can't silently disable
  //    the limit. Used for credential endpoints where "unlimited attempts" during
  //    a Redis blip is a worse outcome than a brief unavailability.
  // Defaults to true to preserve the app-wide availability posture.
  failOpen?: boolean;
}

/**
 * Fixed-window rate limiter backed by Redis INCR + EXPIRE.
 *
 * On a Redis error the behaviour is governed by `failOpen` (see above): the
 * general API surface fails open for availability, while the strict auth limiter
 * fails closed so brute-force protection isn't lost during an outage.
 *
 * NOTE: this is async middleware, so both the limit-exceeded and fail-closed
 * paths are delivered via `next(err)` — NOT `throw`. Throwing here would reject
 * the middleware's promise, which Express 4 does not catch, taking down the
 * process on every rejection.
 */
function rateLimit(opts: RateLimitOptions) {
  const failOpen = opts.failOpen ?? true;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `rl:${opts.keyPrefix}:${ip}`;
    try {
      const redis = getRedis();
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, opts.windowSec);
      const remaining = Math.max(0, opts.max - count);
      res.setHeader('X-RateLimit-Limit', opts.max);
      res.setHeader('X-RateLimit-Remaining', remaining);
      if (count > opts.max) {
        next(new AppError(429, 'Too many requests, please slow down', 'RATE_LIMITED'));
        return;
      }
      next();
    } catch (err) {
      if (failOpen) {
        // Redis unreachable — fail open, but log it.
        logger.warn('Rate limiter unavailable, allowing request', err);
        next();
        return;
      }
      // Fail closed: without a working counter we can't bound attempts, so refuse
      // rather than leave a credential endpoint unthrottled.
      logger.error('Rate limiter unavailable, rejecting request (fail-closed)', err);
      next(new AppError(503, 'Service temporarily unavailable, please retry', 'RATE_LIMIT_UNAVAILABLE'));
    }
  };
}

/**
 * Stricter limit for auth endpoints: 10/min/IP. Fails CLOSED — if the counter
 * store is down we'd rather briefly 503 logins than allow unlimited attempts.
 */
export const authRateLimit = rateLimit({ windowSec: 60, max: 10, keyPrefix: 'auth', failOpen: false });

/** Default app limit: 100/min/IP. Fails open for availability. */
export const defaultRateLimit = rateLimit({ windowSec: 60, max: 100, keyPrefix: 'default' });
