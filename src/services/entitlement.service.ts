import { NextFunction, Request, Response } from 'express';
import { User, IUser } from '../models';
import { AppError } from '../middleware/error';

/**
 * Single source of truth for premium access. Entitlement is always derived from
 * the DB subscription (webhook-updated by RevenueCat in EB-10) — never trusted
 * from the client.
 *
 * Premium = status is active or trial AND the entitlement hasn't expired.
 */
export function isPremium(user: Pick<IUser, 'subscription'>): boolean {
  const sub = user.subscription;
  if (!sub) return false;
  if (sub.status !== 'active' && sub.status !== 'trial') return false;
  if (sub.expiresAt && sub.expiresAt.getTime() <= Date.now()) return false;
  return true;
}

/** Look up whether the signed-in user currently has premium access. */
export async function userIsPremium(userId?: string): Promise<boolean> {
  if (!userId) return false;
  const user = await User.findById(userId).select('subscription');
  return user ? isPremium(user) : false;
}

/**
 * Middleware guarding premium-only endpoints. Must run after requireAuth.
 * Returns a clean 402 PREMIUM_REQUIRED for free users (no provider details).
 */
export function requirePremium(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  void (async () => {
    try {
      if (!req.userId) {
        throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
      }
      if (!(await userIsPremium(req.userId))) {
        throw new AppError(402, 'This is a premium feature', 'PREMIUM_REQUIRED');
      }
      next();
    } catch (err) {
      next(err);
    }
  })();
}
