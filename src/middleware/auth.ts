import { NextFunction, Request, Response } from 'express';
import { AppError } from './error';
import { verifyAccessToken } from '../services/token.service';

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

/** Rejects unless a valid access token is present; attaches req.userId. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearer(req);
  if (!token) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
  const payload = verifyAccessToken(token);
  req.userId = payload.sub;
  next();
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
