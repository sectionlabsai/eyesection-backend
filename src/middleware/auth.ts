import { NextFunction, Request, Response } from 'express';
import { AppError } from './error';
import { verifyAccessToken, isUserRevoked } from '../services/token.service';
import { logger } from '../utils/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

function extractBearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/**
 * Rejects unless a valid access token is present; attaches req.userId.
 *
 * Also consults the revocation blocklist so a suspended / GDPR-deleted user's
 * still-valid (<=15m) access token stops working immediately, rather than
 * lingering until natural expiry. The blocklist lookup fails open: if Redis is
 * unreachable we prefer availability over blocking every authenticated request
 * (consistent with the rate limiter).
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearer(req);
    if (!token) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
    const payload = verifyAccessToken(token);
    if (await isRevokedSafe(payload.sub)) {
      throw new AppError(401, 'Invalid or expired token', 'INVALID_TOKEN');
    }
    req.userId = payload.sub;
    next();
  } catch (err) {
    next(err);
  }
}

/** Revocation lookup that never throws — a Redis outage must not lock everyone out. */
async function isRevokedSafe(userId: string): Promise<boolean> {
  try {
    return await isUserRevoked(userId);
  } catch (err) {
    logger.warn('requireAuth: revocation check failed, allowing request', err);
    return false;
  }
}

/**
 * Attaches req.userId if a valid token is present, but never rejects.
 * Used by the anonymous first-scan flow (EB-04).
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearer(req);
  if (token) {
    try {
      req.userId = verifyAccessToken(token).sub;
    } catch {
      // ignore — remain anonymous
    }
  }
  next();
}
