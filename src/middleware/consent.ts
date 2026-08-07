import { NextFunction, Request, Response } from 'express';
import { User } from '../models';
import { AppError } from './error';

/**
 * Blocks an action until the signed-in user has accepted BOTH terms and
 * privacy. Anonymous callers (no userId — e.g. the EB-04 first-scan funnel)
 * pass through; the app gates consent in the UI before account creation.
 */
export function requireConsent(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  void (async () => {
    try {
      if (!req.userId) return next(); // anonymous — allowed
      const user = await User.findById(req.userId).select('consent');
      if (!user?.consent?.termsAt || !user?.consent?.privacyAt) {
        throw new AppError(
          403,
          'Please accept the Terms and Privacy Policy to continue',
          'CONSENT_REQUIRED',
        );
      }
      next();
    } catch (err) {
      next(err);
    }
  })();
}
