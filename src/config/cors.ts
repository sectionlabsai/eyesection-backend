import { CorsOptions } from 'cors';
import { env, isProd } from './env';
import { logger } from '../utils/logger';

/**
 * CORS policy.
 *
 * The native mobile client is the primary consumer and sends NO Origin header,
 * so it is always allowed (requests with no origin pass through). Browser
 * callers (the admin web panel) must match CORS_ORIGINS exactly.
 *
 * In development, if no allowlist is configured we reflect any origin for
 * convenience. In production an unconfigured allowlist means browser CORS is
 * denied — fail closed rather than silently allowing every site.
 */
export function buildCorsOptions(): CorsOptions {
  const allowlist = env.CORS_ORIGINS;

  if (!isProd && allowlist.length === 0) {
    logger.warn('CORS: no CORS_ORIGINS set — reflecting all origins (development only)');
    return { origin: true, credentials: true };
  }

  return {
    credentials: true,
    origin(origin, callback) {
      // No Origin header => non-browser client (native app, curl, server-to-server).
      if (!origin) return callback(null, true);
      if (allowlist.includes(origin)) return callback(null, true);
      logger.warn(`CORS: blocked disallowed origin ${origin}`);
      return callback(null, false);
    },
  };
}
