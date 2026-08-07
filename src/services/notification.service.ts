import { User, IUser } from '../models';
import { getMessaging } from '../config/firebase';
import { getRedis } from '../config/redis';
import { localDayKey, localTimeHHMM, inTimeWindow } from '../utils/day';
import { logger } from '../utils/logger';

/**
 * Server-sent push notifications (EB-11). Break / blink / comfort reminders are
 * NOT here — those are LOCAL notifications scheduled on-device by the client
 * (EB-08). This service only sends the transactional + engagement pushes in the
 * catalog below.
 *
 * Gating rules:
 *  - transactional pushes (results, billing) always send;
 *  - engagement pushes respect the per-category preference, quiet hours
 *    (default 21:00–08:00 in the user's timezone) and a max of one per day.
 * All copy is cosmetic / wellness framing — never a health claim.
 */

type PrefKey = 'results' | 'breaks' | 'comfort' | 'marketing';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushOptions {
  category: PrefKey; // which notificationPrefs toggle governs it
  transactional?: boolean; // bypass prefs, quiet hours and throttle
}

export interface PushResult {
  sent: boolean;
  reason?: string;
  delivered?: number;
}

const ENGAGEMENT_TTL_SEC = 24 * 60 * 60;

function engagementKey(userId: string, tz: string): string {
  return `notif:eng:${userId}:${localDayKey(new Date(), tz)}`;
}

/**
 * Low-level send with all gating applied. Loads the user's tokens + prefs,
 * respects the rules above, delivers via FCM and prunes dead tokens.
 */
export async function sendPush(
  userId: string,
  payload: PushPayload,
  opts: PushOptions,
): Promise<PushResult> {
  const user = await User.findById(userId).select(
    'fcmTokens notificationPrefs',
  );
  if (!user) return { sent: false, reason: 'user_not_found' };

  const tokens = user.fcmTokens ?? [];
  if (tokens.length === 0) return { sent: false, reason: 'no_tokens' };

  const transactional = opts.transactional === true;
  const prefs = user.notificationPrefs;
  const tz = prefs?.timezone || 'UTC';

  if (!transactional) {
    // Per-category preference.
    if (prefs && prefs[opts.category] === false) {
      return { sent: false, reason: 'pref_off' };
    }
    // Quiet hours (local).
    const now = localTimeHHMM(new Date(), tz);
    const qStart = prefs?.quietStart || '21:00';
    const qEnd = prefs?.quietEnd || '08:00';
    if (inTimeWindow(now, qStart, qEnd)) {
      return { sent: false, reason: 'quiet_hours' };
    }
    // Throttle: at most one engagement push per local day.
    const redis = getRedis();
    const key = engagementKey(userId, tz);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ENGAGEMENT_TTL_SEC);
    if (count > 1) return { sent: false, reason: 'throttled' };
  }

  const delivered = await deliver(user, tokens, payload);
  return { sent: delivered > 0, delivered, reason: delivered ? undefined : 'no_delivery' };
}

/** Push to FCM and prune tokens the provider reports as dead. */
async function deliver(
  user: IUser,
  tokens: string[],
  payload: PushPayload,
): Promise<number> {
  let response;
  try {
    response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.data,
    });
  } catch (err) {
    logger.error(`Push send failed for user ${user._id}`, err);
    return 0;
  }

  const dead: string[] = [];
  response.responses.forEach((r, i) => {
    if (r.success) return;
    const code = r.error?.code ?? '';
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    ) {
      dead.push(tokens[i]);
    }
  });

  if (dead.length > 0) {
    await User.updateOne(
      { _id: user._id },
      { $pull: { fcmTokens: { $in: dead } } },
    );
    logger.info(`Pruned ${dead.length} dead FCM token(s) for user ${user._id}`);
  }

  return response.successCount;
}

/* ------------------------------- Catalog -------------------------------- */

export type NotificationType =
  | 'ResultsReady'
  | 'ScanFailed'
  | 'WeeklyScanNudge'
  | 'FreshnessImproved'
  | 'StreakMilestone'
  | 'WinBack'
  | 'TrialEnding'
  | 'BillingIssue';

interface CatalogEntry {
  category: PrefKey;
  transactional: boolean;
  build: (ctx: Record<string, string | number>) => PushPayload;
}

const CATALOG: Record<NotificationType, CatalogEntry> = {
  ResultsReady: {
    category: 'results',
    transactional: true,
    build: () => ({
      title: 'Your eye results are ready ✨',
      body: 'Tap to see your latest Eye Freshness score and tips.',
      data: { type: 'ResultsReady' },
    }),
  },
  ScanFailed: {
    category: 'results',
    transactional: true,
    build: () => ({
      title: 'Let’s try that scan again',
      body: 'We couldn’t finish your last scan. A quick retake usually does it.',
      data: { type: 'ScanFailed' },
    }),
  },
  WeeklyScanNudge: {
    category: 'results',
    transactional: false,
    build: () => ({
      title: 'Time for a fresh check-in 👀',
      body: 'A quick scan keeps your freshness trend up to date.',
      data: { type: 'WeeklyScanNudge' },
    }),
  },
  FreshnessImproved: {
    category: 'results',
    transactional: false,
    build: (ctx) => ({
      title: 'Your eyes are looking fresher! 🌿',
      body: `Your freshness score is up${ctx.delta ? ` by ${ctx.delta}` : ''}. Lovely progress.`,
      data: { type: 'FreshnessImproved' },
    }),
  },
  StreakMilestone: {
    category: 'results',
    transactional: false,
    build: (ctx) => ({
      title: `${ctx.streak ?? ''}-day streak! 🔥`.trim(),
      body: 'You’ve been kind to your eyes every day — keep the rhythm going.',
      data: { type: 'StreakMilestone' },
    }),
  },
  WinBack: {
    category: 'marketing',
    transactional: false,
    build: () => ({
      title: 'Your eyes miss you 💙',
      body: 'It’s been a while — a quick 30-second reset can help you feel refreshed.',
      data: { type: 'WinBack' },
    }),
  },
  TrialEnding: {
    category: 'results',
    transactional: true,
    build: () => ({
      title: 'Your premium trial is ending soon',
      body: 'Keep your before-after insights and full history — manage your plan anytime.',
      data: { type: 'TrialEnding' },
    }),
  },
  BillingIssue: {
    category: 'results',
    transactional: true,
    build: () => ({
      title: 'There was a billing hiccup',
      body: 'We couldn’t process your subscription payment. Please update your billing to keep premium.',
      data: { type: 'BillingIssue' },
    }),
  },
};

/** Compose and send a catalog notification. */
export async function trigger(
  type: NotificationType,
  userId: string,
  ctx: Record<string, string | number> = {},
): Promise<PushResult> {
  const entry = CATALOG[type];
  return sendPush(userId, entry.build(ctx), {
    category: entry.category,
    transactional: entry.transactional,
  });
}

/* ------------------------------ Broadcast ------------------------------ */

export type Segment = 'all' | 'premium' | 'free' | 'trial';

const FCM_MULTICAST_LIMIT = 500; // FCM caps sendEachForMulticast at 500 tokens

export function segmentQuery(segment: Segment): Record<string, unknown> {
  switch (segment) {
    case 'premium':
      return { 'subscription.status': { $in: ['active', 'trial'] } };
    case 'trial':
      return { 'subscription.status': 'trial' };
    case 'free':
      return { 'subscription.status': { $in: ['free', 'expired'] } };
    default:
      return {};
  }
}

/**
 * Admin broadcast to a segment. Runs OFF the request thread (called from the
 * broadcast queue worker) and sends via FCM in 500-token multicast batches
 * instead of one call per user. Dead tokens are pruned in bulk. This is a
 * transactional admin message, so per-user prefs/quiet-hours/throttle do not
 * apply — the same as the single-user admin send.
 */
export async function broadcastToSegment(
  segment: Segment,
  payload: PushPayload,
): Promise<{ targetedUsers: number; tokens: number; delivered: number; pruned: number }> {
  const users = await User.find({
    ...segmentQuery(segment),
    fcmTokens: { $exists: true, $ne: [] },
  }).select('_id fcmTokens');

  // Flatten to (userId, token) pairs so we can prune per-user on failure.
  const pairs: { userId: string; token: string }[] = [];
  for (const u of users) {
    for (const t of u.fcmTokens ?? []) pairs.push({ userId: u._id.toString(), token: t });
  }
  if (pairs.length === 0) {
    return { targetedUsers: users.length, tokens: 0, delivered: 0, pruned: 0 };
  }

  const messaging = getMessaging();
  const deadByUser = new Map<string, string[]>();
  let delivered = 0;

  for (let i = 0; i < pairs.length; i += FCM_MULTICAST_LIMIT) {
    const batch = pairs.slice(i, i + FCM_MULTICAST_LIMIT);
    try {
      const response = await messaging.sendEachForMulticast({
        tokens: batch.map((p) => p.token),
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      });
      delivered += response.successCount;
      response.responses.forEach((r, idx) => {
        if (r.success) return;
        const code = r.error?.code ?? '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          const { userId, token } = batch[idx];
          const list = deadByUser.get(userId) ?? [];
          list.push(token);
          deadByUser.set(userId, list);
        }
      });
    } catch (err) {
      logger.error(`Broadcast batch failed (offset ${i})`, err);
    }
  }

  let pruned = 0;
  if (deadByUser.size > 0) {
    const ops = [...deadByUser.entries()].map(([userId, tokens]) => {
      pruned += tokens.length;
      return {
        updateOne: {
          filter: { _id: userId },
          update: { $pull: { fcmTokens: { $in: tokens } } },
        },
      };
    });
    await User.bulkWrite(ops);
  }

  logger.info(
    `Broadcast to '${segment}': ${users.length} users, ${pairs.length} tokens, ${delivered} delivered, ${pruned} pruned`,
  );
  return { targetedUsers: users.length, tokens: pairs.length, delivered, pruned };
}
