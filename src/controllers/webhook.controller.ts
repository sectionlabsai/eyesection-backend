import { Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { AppError } from '../middleware/error';
import * as subscriptionService from '../services/subscription.service';
import { logger } from '../utils/logger';

/** Constant-time string compare — avoids leaking the secret via response timing. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * RevenueCat webhook. Authenticated by a shared secret sent in the
 * Authorization header (configured in the RevenueCat dashboard) — compared
 * against REVENUECAT_WEBHOOK_AUTH.
 *
 * We return 200 for anything we successfully received and evaluated (including
 * "no matching user" / "stale event") so RevenueCat does not retry endlessly;
 * only auth/config failures are non-2xx.
 */
export async function revenuecat(req: Request, res: Response): Promise<void> {
  if (!env.REVENUECAT_WEBHOOK_AUTH) {
    logger.error('RevenueCat webhook hit but REVENUECAT_WEBHOOK_AUTH is not configured');
    throw new AppError(503, 'Billing webhook not configured', 'WEBHOOK_UNCONFIGURED');
  }

  const auth = req.header('authorization');
  if (!auth || !safeEqual(auth, env.REVENUECAT_WEBHOOK_AUTH)) {
    throw new AppError(401, 'Invalid webhook signature', 'WEBHOOK_UNAUTHORIZED');
  }

  const result = await subscriptionService.handleWebhook(req.body);
  res.status(200).json({ received: true, ...result });
}
