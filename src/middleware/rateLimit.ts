import { NextFunction, Request, Response } from 'express';
import { getRedis } from '../config/redis';
import { AppError } from './error';
import { logger } from '../utils/logger';

interface RateLimitOptions {
  windowSec: number;
  max: number;
  keyPrefix: string;
}

/**
 * Fixed-window rate limiter backed by Redis INCR + EXPIRE.
 * Fails open (allows the request) if Redis is unreachable — availability over
 * strictness for a cosmetic app, but the error is logged.
 *
 * NOTE: this is async middleware, so the limit-exceeded path is delivered via
 * `next(err)` — NOT `throw`. Throwing here would reject the middleware's promise,
 * which Express 4 does not catch, taking down the process on every 429.
 */
function rateLimit(opts: RateLimitOptions) {
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
      // Redis unreachable — fail open, but log it.
      logger.warn('Rate limiter unavailable, allowing request', err);
      next();
    }
  };
}

/** Stricter limit for auth endpoints: 10/min/IP. */
export const authRateLimit = rateLimit({ windowSec: 60, max: 10, keyPrefix: 'auth' });

/** Default app limit: 100/min/IP. */
export const defaultRateLimit = rateLimit({ windowSec: 60, max: 100, keyPrefix: 'default' });
