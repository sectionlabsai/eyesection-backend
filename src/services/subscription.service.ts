import axios from 'axios';
import { Types } from 'mongoose';
import { User, IUser } from '../models';
import { SubscriptionStatus } from '../models/User';
import { AppError } from '../middleware/error';
import { env } from '../config/env';
import { isPremium } from './entitlement.service';
import * as notifications from './notification.service';
import { logger } from '../utils/logger';

/**
 * RevenueCat webhook handling. The backend is the SINGLE SOURCE OF TRUTH for
 * entitlement — the client is never trusted. Every relevant event updates the
 * user's subscription in the DB; `isPremium` then derives access from that.
 *
 * Entitlement id: `premium`.
 * Products: com.eyesection.premium.monthly / com.eyesection.premium.annual.
 */

export type RcEventType =
  | 'INITIAL_PURCHASE'
  | 'RENEWAL'
  | 'CANCELLATION'
  | 'EXPIRATION'
  | 'BILLING_ISSUE'
  | 'PRODUCT_CHANGE'
  | 'UNCANCELLATION';

export interface RcEvent {
  type: RcEventType | string;
  app_user_id?: string;
  original_app_user_id?: string;
  aliases?: string[];
  product_id?: string;
  period_type?: 'TRIAL' | 'INTRO' | 'NORMAL' | string;
  expiration_at_ms?: number;
  event_timestamp_ms?: number;
  entitlement_ids?: string[];
}

export interface RcWebhookBody {
  event?: RcEvent;
  api_version?: string;
}

// Events that (re)grant access; the rest either revoke or are informational.
const GRANTING: RcEventType[] = [
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
  'PRODUCT_CHANGE',
  'CANCELLATION', // auto-renew off, but access continues until expiry
];

/** Map a RevenueCat product id to our simple plan label. */
function planFromProduct(productId?: string): string | undefined {
  if (!productId) return undefined;
  if (/annual/i.test(productId)) return 'annual';
  if (/monthly/i.test(productId)) return 'monthly';
  return productId;
}

/** Resolve the app user for an event to one of our users. */
async function findUserForEvent(event: RcEvent): Promise<IUser | null> {
  const candidates = [
    event.app_user_id,
    event.original_app_user_id,
    ...(event.aliases ?? []),
  ].filter((v): v is string => !!v);

  if (candidates.length === 0) return null;

  // Primary mapping: rcAppUserId (set to the user's _id at signup / link).
  const byRc = await User.findOne({
    'subscription.rcAppUserId': { $in: candidates },
  });
  if (byRc) return byRc;

  // Fallback: an id that is itself a valid user _id.
  for (const id of candidates) {
    if (Types.ObjectId.isValid(id)) {
      const byId = await User.findById(id);
      if (byId) return byId;
    }
  }
  return null;
}

interface DerivedState {
  status: SubscriptionStatus;
  entitlement?: string;
  expiresAt?: Date;
}

/** Derive the DB subscription state from the event. */
function deriveState(event: RcEvent): DerivedState {
  const type = event.type as RcEventType;
  const expiresAt = event.expiration_at_ms
    ? new Date(event.expiration_at_ms)
    : undefined;
  const isTrial = event.period_type === 'TRIAL' || event.period_type === 'INTRO';

  if (type === 'EXPIRATION') {
    return { status: 'expired', entitlement: undefined, expiresAt };
  }
  if (GRANTING.includes(type)) {
    return {
      status: isTrial ? 'trial' : 'active',
      entitlement: 'premium',
      expiresAt,
    };
  }
  // BILLING_ISSUE and anything unrecognised: don't flip status here (RevenueCat
  // keeps access during the grace period). We still refresh expiry if present.
  return { status: null as unknown as SubscriptionStatus, expiresAt };
}

export interface WebhookResult {
  handled: boolean;
  reason?: string;
  userId?: string;
}

/**
 * Process a verified webhook body. Idempotent: events older than or equal to
 * the last one we processed for that user are ignored, so duplicate/out-of-order
 * deliveries are safe.
 */
export async function handleWebhook(body: RcWebhookBody): Promise<WebhookResult> {
  const event = body.event;
  if (!event || !event.type) return { handled: false, reason: 'no_event' };

  const user = await findUserForEvent(event);
  if (!user) {
    // Acknowledge (200) so RevenueCat stops retrying — the user may have been
    // deleted (GDPR) or never linked. We log for observability.
    logger.warn(
      `RevenueCat ${event.type}: no matching user for app_user_id=${event.app_user_id}`,
    );
    return { handled: false, reason: 'user_not_found' };
  }

  // Idempotency / ordering guard.
  const eventMs = event.event_timestamp_ms ?? 0;
  const lastMs = user.subscription.lastEventAt?.getTime() ?? 0;
  if (eventMs && eventMs <= lastMs) {
    return { handled: false, reason: 'stale_event', userId: user._id.toString() };
  }

  const derived = deriveState(event);
  const plan = planFromProduct(event.product_id);

  if (derived.status) user.subscription.status = derived.status;
  if (plan) user.subscription.plan = plan;
  if ('entitlement' in derived && event.type !== 'BILLING_ISSUE') {
    user.subscription.entitlement = derived.entitlement;
  }
  if (derived.expiresAt) user.subscription.expiresAt = derived.expiresAt;
  if (eventMs) user.subscription.lastEventAt = new Date(eventMs);

  await user.save();

  // Notification triggers — wired to the EB-11 notification service once built.
  if (event.type === 'BILLING_ISSUE') {
    triggerBillingIssueNotification(user._id.toString());
  } else if (event.type === 'CANCELLATION' && event.period_type === 'TRIAL') {
    triggerTrialEndingNotification(user._id.toString());
  }

  logger.info(
    `RevenueCat ${event.type} applied to user ${user._id} → status=${user.subscription.status}`,
  );
  return { handled: true, userId: user._id.toString() };
}

/* --- Notification triggers (EB-11). Fire-and-forget; never block the webhook. --- */

function triggerBillingIssueNotification(userId: string): void {
  notifications
    .trigger('BillingIssue', userId)
    .catch((err) => logger.error(`Billing Issue notify failed for ${userId}`, err));
}

function triggerTrialEndingNotification(userId: string): void {
  notifications
    .trigger('TrialEnding', userId)
    .catch((err) => logger.error(`Trial Ending notify failed for ${userId}`, err));
}

/* --------------------------------- Reads --------------------------------- */

export async function getStatus(userId: string): Promise<Record<string, unknown>> {
  const user = await User.findById(userId).select('subscription');
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  const sub = user.subscription;
  return {
    status: sub.status,
    plan: sub.plan ?? null,
    entitlement: sub.entitlement ?? null,
    expiresAt: sub.expiresAt ?? null,
    isPremium: isPremium(user),
  };
}

/**
 * Re-sync a user's entitlement directly from the RevenueCat REST API (admin
 * action / reconciliation). Reads the `premium` entitlement and updates the DB.
 */
export async function refreshFromRevenueCat(
  userId: string,
): Promise<Record<string, unknown>> {
  if (!env.REVENUECAT_API_KEY) {
    throw new AppError(503, 'RevenueCat is not configured', 'REVENUECAT_UNCONFIGURED');
  }
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');

  const appUserId = user.subscription.rcAppUserId || user._id.toString();

  let subscriber: Record<string, unknown>;
  try {
    const res = await axios.get(
      `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(appUserId)}`,
      { headers: { Authorization: `Bearer ${env.REVENUECAT_API_KEY}` }, timeout: 10_000 },
    );
    subscriber = (res.data as { subscriber?: Record<string, unknown> }).subscriber ?? {};
  } catch (err) {
    logger.error(`RevenueCat refresh failed for user ${userId}`, err);
    throw new AppError(502, 'Could not reach RevenueCat', 'REVENUECAT_UNREACHABLE');
  }

  const entitlements = (subscriber.entitlements ?? {}) as Record<
    string,
    { expires_date?: string; product_identifier?: string }
  >;
  const premium = entitlements.premium;
  const expiresAt = premium?.expires_date ? new Date(premium.expires_date) : undefined;
  const active = !!premium && (!expiresAt || expiresAt.getTime() > Date.now());

  user.subscription.status = active ? 'active' : 'expired';
  user.subscription.entitlement = active ? 'premium' : undefined;
  user.subscription.plan = planFromProduct(premium?.product_identifier) ?? user.subscription.plan;
  if (expiresAt) user.subscription.expiresAt = expiresAt;
  await user.save();

  return getStatus(userId);
}

/** Bind rcAppUserId to the user's _id (idempotent). */
export async function linkAppUser(
  userId: string,
): Promise<{ rcAppUserId: string }> {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  if (user.subscription.rcAppUserId !== user._id.toString()) {
    user.subscription.rcAppUserId = user._id.toString();
    await user.save();
  }
  return { rcAppUserId: user.subscription.rcAppUserId! };
}

const SIMULATED_TRIAL_DAYS = 7;

/**
 * Pre-launch helper: grant the caller a simulated 7-day premium trial by
 * writing it to their DB subscription. Because entitlement is always derived
 * from the DB (see entitlement.service), this keeps premium consistent across
 * the WHOLE app — client UI *and* server-gated endpoints — before RevenueCat
 * is wired.
 *
 * Hard-disabled once RevenueCat is configured: real entitlement then flows only
 * through verified webhooks, and the client is expected to drive purchases
 * through the RevenueCat SDK instead of this endpoint.
 */
export async function simulateTrial(
  userId: string,
  plan?: string,
): Promise<Record<string, unknown>> {
  if (env.REVENUECAT_API_KEY) {
    throw new AppError(
      403,
      'Simulated trials are disabled once billing is live',
      'SIMULATION_DISABLED',
    );
  }

  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');

  const normalizedPlan = plan === 'monthly' ? 'monthly' : 'annual';
  const expiresAt = new Date(
    Date.now() + SIMULATED_TRIAL_DAYS * 24 * 60 * 60 * 1000,
  );

  user.subscription.status = 'trial';
  user.subscription.entitlement = 'premium';
  user.subscription.plan = normalizedPlan;
  user.subscription.expiresAt = expiresAt;
  if (!user.subscription.rcAppUserId) {
    user.subscription.rcAppUserId = user._id.toString();
  }
  await user.save();

  logger.warn(
    `Simulated premium trial granted to user ${userId} (plan=${normalizedPlan}) — RevenueCat unconfigured`,
  );
  return getStatus(userId);
}
