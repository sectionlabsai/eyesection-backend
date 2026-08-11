import bcrypt from 'bcrypt';
import mongoose, { Types } from 'mongoose';
import {
  AdminUser,
  User,
  EyeScan,
  ComfortEntry,
  ExerciseSession,
  Exercise,
  Report,
  AdminNotificationLog,
} from '../models';
import { AppError } from '../middleware/error';
import { signAdminToken } from '../middleware/adminAuth';
import { getAnalyzeQueue, enqueueAnalyzeScan } from '../config/queue';
import { getExportQueue } from '../config/exportQueue';
import { enqueueBroadcast } from '../config/broadcastQueue';
import { runRetentionSweep } from '../jobs/retention.job';
import { deleteAccount } from './gdpr.service';
import { refreshFromRevenueCat } from './subscription.service';
import * as notifications from './notification.service';
import { Segment } from './notification.service';
import { revokeUserTokens } from './token.service';
import {
  getSignedUrl,
  deleteMany,
  storageStats,
  ping as s3Ping,
  StorageStats,
} from './s3.service';
import { getRedis } from '../config/redis';
import { env } from '../config/env';

// Rough monthly-equivalent prices for the MRR estimate (display only).
const PRICE_MONTHLY = 9.99;
const PRICE_ANNUAL_MONTHLY_EQ = 59.99 / 12;

interface Paginated<T> {
  data: T[];
  page: number;
  total: number;
  pages: number;
}

function paginate<T>(data: T[], page: number, total: number, limit: number): Paginated<T> {
  return { data, page, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

/* ------------------------------- Auth ---------------------------------- */

// A valid cost-12 bcrypt hash of a throwaway string, compared against on the
// unknown-admin path so login timing doesn't reveal whether the email exists.
const DUMMY_BCRYPT_HASH = '$2b$12$MX16Gjnp1/abrhQREO6sau87hY8XXzG5V6p/MGw8IfFnr9IvSb5wi';

// Per-account lockout for admin login. The 10/min IP rate limit alone doesn't
// stop a distributed (many-IP) credential-stuffing run against a single admin
// account, so we also lock the account after too many failures. Fail-open on
// Redis errors — an outage must not permanently lock admins out.
const ADMIN_LOGIN_MAX_FAILURES = 5;
const ADMIN_LOGIN_LOCK_SEC = 15 * 60; // 15 minutes

function adminFailKey(email: string): string {
  return `admin:login:fail:${email.toLowerCase()}`;
}

async function isAdminLoginLocked(email: string): Promise<boolean> {
  try {
    const raw = await getRedis().get(adminFailKey(email));
    return raw !== null && parseInt(raw, 10) >= ADMIN_LOGIN_MAX_FAILURES;
  } catch {
    return false; // fail open
  }
}

async function recordAdminLoginFailure(email: string): Promise<void> {
  try {
    const key = adminFailKey(email);
    await getRedis().incr(key);
    // Sliding window: each failure re-arms the 15-minute expiry.
    await getRedis().expire(key, ADMIN_LOGIN_LOCK_SEC);
  } catch {
    // fail open — don't let a Redis blip block a legitimate login attempt
  }
}

async function clearAdminLoginFailures(email: string): Promise<void> {
  try {
    await getRedis().del(adminFailKey(email));
  } catch {
    // best effort
  }
}

export async function login(
  email: string,
  password: string,
): Promise<{ adminToken: string; admin: Record<string, unknown> }> {
  // When locked, return the SAME generic error as a bad password — never reveal
  // the lock, or an attacker learns which accounts they've successfully tripped.
  if (await isAdminLoginLocked(email)) {
    throw new AppError(401, 'Invalid credentials', 'ADMIN_INVALID_CREDENTIALS');
  }

  const admin = await AdminUser.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!admin) {
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
    await recordAdminLoginFailure(email);
    throw new AppError(401, 'Invalid credentials', 'ADMIN_INVALID_CREDENTIALS');
  }
  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) {
    await recordAdminLoginFailure(email);
    throw new AppError(401, 'Invalid credentials', 'ADMIN_INVALID_CREDENTIALS');
  }

  await clearAdminLoginFailures(email);
  admin.lastLoginAt = new Date();
  await admin.save();

  return {
    adminToken: signAdminToken(admin._id.toString(), admin.role),
    admin: { id: admin._id.toString(), email: admin.email, role: admin.role },
  };
}

/** Resolve the admin behind a valid token (for /auth/me refresh). */
export async function me(adminId: string): Promise<Record<string, unknown>> {
  const admin = await AdminUser.findById(adminId);
  if (!admin) throw new AppError(401, 'Admin not found', 'ADMIN_UNAUTHENTICATED');
  return { id: admin._id.toString(), email: admin.email, role: admin.role };
}

/* ------------------------------- Stats --------------------------------- */

export async function statsOverview(): Promise<Record<string, unknown>> {
  const now = Date.now();
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const since24h = new Date(now - 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    activeSubs,
    trials,
    scans7d,
    scansTotal,
    failedScans24h,
    monthlyActive,
    annualActive,
    queueCounts,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ 'subscription.status': 'active' }),
    User.countDocuments({ 'subscription.status': 'trial' }),
    EyeScan.countDocuments({ createdAt: { $gte: since7d } }),
    EyeScan.countDocuments(),
    EyeScan.countDocuments({ status: 'failed', updatedAt: { $gte: since24h } }),
    User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'monthly' }),
    User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'annual' }),
    getAnalyzeQueue().getJobCounts('waiting', 'active', 'delayed'),
  ]);

  const mrrEstimate = Math.round(
    (monthlyActive * PRICE_MONTHLY + annualActive * PRICE_ANNUAL_MONTHLY_EQ) * 100,
  ) / 100;
  const queueDepth =
    (queueCounts.waiting ?? 0) + (queueCounts.active ?? 0) + (queueCounts.delayed ?? 0);

  return {
    totalUsers,
    activeSubs,
    trials,
    scans7d,
    scansTotal,
    mrrEstimate,
    queueDepth,
    failedScans24h,
  };
}

/* --------------------------- Stats: trends ----------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Build a zero-filled map of the last `days` day-keys (YYYY-MM-DD, UTC). */
function emptyDayBuckets(days: number): Map<string, number> {
  const map = new Map<string, number>();
  const start = new Date(Date.now() - (days - 1) * DAY_MS);
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * DAY_MS);
    map.set(d.toISOString().slice(0, 10), 0);
  }
  return map;
}

async function countByDay(
  model: typeof User | typeof EyeScan,
  dateField: string,
  days: number,
): Promise<Map<string, number>> {
  const since = new Date(Date.now() - (days - 1) * DAY_MS);
  const rows = await model.aggregate<{ _id: string; count: number }>([
    { $match: { [dateField]: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: `$${dateField}`, timezone: 'UTC' } },
        count: { $sum: 1 },
      },
    },
  ]);
  const buckets = emptyDayBuckets(days);
  for (const r of rows) if (buckets.has(r._id)) buckets.set(r._id, r.count);
  return buckets;
}

/** Daily signups over the last 30 days, plus a running cumulative total. */
export async function statsGrowth(days = 30): Promise<Record<string, unknown>[]> {
  const buckets = await countByDay(User, 'createdAt', days);
  const since = new Date(Date.now() - (days - 1) * DAY_MS);
  let running = await User.countDocuments({ createdAt: { $lt: since } });
  return [...buckets.entries()].map(([date, signups]) => {
    running += signups;
    return { date, signups, total: running };
  });
}

/** Daily scan volume over the last 30 days. */
export async function statsScans(days = 30): Promise<Record<string, unknown>[]> {
  const buckets = await countByDay(EyeScan, 'createdAt', days);
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

/**
 * Daily revenue estimate. There is no purchase-event store, so this spreads the
 * current MRR evenly across the window as a display-only approximation.
 */
export async function statsRevenue(days = 30): Promise<Record<string, unknown>[]> {
  const [monthlyActive, annualActive] = await Promise.all([
    User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'monthly' }),
    User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'annual' }),
  ]);
  const mrr = monthlyActive * PRICE_MONTHLY + annualActive * PRICE_ANNUAL_MONTHLY_EQ;
  const daily = Math.round((mrr / 30) * 100) / 100;
  const buckets = emptyDayBuckets(days);
  return [...buckets.keys()].map((date) => ({ date, usd: daily }));
}

/** Actionable items surfaced on the overview page. */
export async function needsAttention(): Promise<Record<string, unknown>> {
  const since24h = new Date(Date.now() - DAY_MS);
  const [failedScans, expiredSubs, exportJobs] = await Promise.all([
    EyeScan.countDocuments({ status: 'failed', updatedAt: { $gte: since24h } }),
    User.countDocuments({ 'subscription.status': 'expired' }),
    getExportQueue().getJobCounts('waiting', 'active'),
  ]);
  const pendingGdpr = (exportJobs.waiting ?? 0) + (exportJobs.active ?? 0);

  const items: Record<string, unknown>[] = [];
  if (failedScans > 0) {
    items.push({
      id: 'failed_scans',
      kind: 'failed_scans',
      label: `${failedScans} failed scan${failedScans === 1 ? '' : 's'} in the last 24h`,
      href: '/scans?status=failed',
    });
  }
  if (pendingGdpr > 0) {
    items.push({
      id: 'gdpr_pending',
      kind: 'gdpr_pending',
      label: `${pendingGdpr} GDPR export${pendingGdpr === 1 ? '' : 's'} in progress`,
      href: '/gdpr-requests',
    });
  }
  if (expiredSubs > 0) {
    items.push({
      id: 'expired_subs',
      kind: 'expired_subs',
      label: `${expiredSubs} expired subscription${expiredSubs === 1 ? '' : 's'}`,
      href: '/subscriptions?plan=expired',
    });
  }
  return { items };
}

/* ------------------------------- Users --------------------------------- */

export async function listUsers(opts: {
  search?: string;
  plan?: string;
  page: number;
  limit: number;
}): Promise<Paginated<Record<string, unknown>>> {
  const query: Record<string, unknown> = {};
  if (opts.search) query.email = { $regex: opts.search, $options: 'i' };
  if (opts.plan) query['subscription.status'] = opts.plan;

  const [total, users] = await Promise.all([
    User.countDocuments(query),
    User.find(query)
      .sort({ createdAt: -1 })
      .skip((opts.page - 1) * opts.limit)
      .limit(opts.limit)
      .select('email displayName status subscription createdAt lastActiveAt'),
  ]);

  const data = users.map((u) => ({
    id: u._id.toString(),
    email: u.email,
    displayName: u.displayName ?? null,
    status: u.status,
    plan: u.subscription.plan ?? null,
    subscriptionStatus: u.subscription.status,
    createdAt: u.createdAt,
    lastActiveAt: u.lastActiveAt ?? null,
  }));

  return paginate(data, opts.page, total, opts.limit);
}

export async function getUser(userId: string): Promise<Record<string, unknown>> {
  if (!Types.ObjectId.isValid(userId)) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');

  const uid = user._id;
  const [scanCount, comfortCount, sessionCount, reportCount] = await Promise.all([
    EyeScan.countDocuments({ userId: uid }),
    ComfortEntry.countDocuments({ userId: uid }),
    ExerciseSession.countDocuments({ userId: uid }),
    Report.countDocuments({ userId: uid }),
  ]);

  return {
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName ?? null,
    status: user.status,
    authProvider: user.authProvider,
    concerns: user.concerns,
    goal: user.goal,
    careProducts: user.careProducts,
    baselineComfort: user.baselineComfort,
    screenProfile: user.screenProfile,
    subscription: user.subscription,
    consent: user.consent,
    notificationPrefs: user.notificationPrefs,
    createdAt: user.createdAt,
    counts: {
      scans: scanCount,
      comfortEntries: comfortCount,
      exerciseSessions: sessionCount,
      reports: reportCount,
    },
  };
}

export async function setUserStatus(
  userId: string,
  status: 'active' | 'suspended',
): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  user.status = status;
  await user.save();
  // Suspending cuts existing sessions off at the next refresh.
  if (status === 'suspended') await revokeUserTokens(userId);
  return { id: user._id.toString(), status: user.status };
}

/** Full GDPR cascade delete (reuses EB-11). */
export async function deleteUser(userId: string): Promise<void> {
  if (!Types.ObjectId.isValid(userId)) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  }
  await deleteAccount(userId);
}

/* ------------------------------- Scans --------------------------------- */

async function scanThumbs(scan: {
  images: { front: { thumb?: string }; closeup?: { thumb?: string } };
}): Promise<{ frontThumbUrl: string | null; closeupThumbUrl: string | null }> {
  return {
    frontThumbUrl: scan.images.front?.thumb ? await getSignedUrl(scan.images.front.thumb) : null,
    closeupThumbUrl: scan.images.closeup?.thumb
      ? await getSignedUrl(scan.images.closeup.thumb)
      : null,
  };
}

export async function listScans(opts: {
  status?: string;
  page: number;
  limit: number;
}): Promise<Paginated<Record<string, unknown>>> {
  const query: Record<string, unknown> = {};
  if (opts.status) query.status = opts.status;

  const [total, scans] = await Promise.all([
    EyeScan.countDocuments(query),
    EyeScan.find(query)
      .sort({ createdAt: -1 })
      .skip((opts.page - 1) * opts.limit)
      .limit(opts.limit),
  ]);

  const data = await Promise.all(
    scans.map(async (s) => ({
      id: s._id.toString(),
      userId: s.userId?.toString() ?? null,
      status: s.status,
      freshnessScore: s.analysis?.freshnessScore ?? null,
      createdAt: s.createdAt,
      ...(await scanThumbs(s)),
    })),
  );

  return paginate(data, opts.page, total, opts.limit);
}

export async function getScan(scanId: string): Promise<Record<string, unknown>> {
  if (!Types.ObjectId.isValid(scanId)) {
    throw new AppError(404, 'Scan not found', 'SCAN_NOT_FOUND');
  }
  const scan = await EyeScan.findById(scanId);
  if (!scan) throw new AppError(404, 'Scan not found', 'SCAN_NOT_FOUND');

  const frontRawUrl = scan.images.front?.raw ? await getSignedUrl(scan.images.front.raw) : null;
  const closeupRawUrl = scan.images.closeup?.raw
    ? await getSignedUrl(scan.images.closeup.raw)
    : null;

  return {
    id: scan._id.toString(),
    userId: scan.userId?.toString() ?? null,
    status: scan.status,
    geometry: scan.geometry,
    analysis: scan.analysis,
    iris: scan.iris,
    aiRaw: scan.aiRaw ?? null,
    errorReason: scan.errorReason ?? null,
    images: { frontRawUrl, closeupRawUrl, ...(await scanThumbs(scan)) },
    createdAt: scan.createdAt,
  };
}

export async function reprocessScan(scanId: string): Promise<Record<string, unknown>> {
  const scan = await EyeScan.findById(scanId);
  if (!scan) throw new AppError(404, 'Scan not found', 'SCAN_NOT_FOUND');
  scan.status = 'pending';
  scan.errorReason = undefined;
  await scan.save();
  await enqueueAnalyzeScan(scan._id.toString());
  return { id: scan._id.toString(), status: scan.status };
}

/** Delete a scan's photos from S3 but KEEP the computed scores. */
export async function deleteScanPhotos(scanId: string): Promise<Record<string, unknown>> {
  const scan = await EyeScan.findById(scanId);
  if (!scan) throw new AppError(404, 'Scan not found', 'SCAN_NOT_FOUND');

  const keys = [
    scan.images.front?.raw,
    scan.images.front?.thumb,
    scan.images.front?.eyeThumb,
    scan.images.closeup?.raw,
    scan.images.closeup?.thumb,
  ].filter((k): k is string => !!k);

  await deleteMany(keys);
  scan.images.front = {};
  scan.images.closeup = undefined;
  scan.rawDeleteAt = undefined;
  await scan.save();

  return { id: scan._id.toString(), photosDeleted: keys.length };
}

/* ------------------------------ Storage -------------------------------- */

export async function getStorageStats(): Promise<StorageStats> {
  return storageStats('users/');
}

export async function purgeExpiredRaw(): Promise<Record<string, unknown>> {
  const cleared = await runRetentionSweep();
  return { scansPurged: cleared };
}

/** Scans that still hold raw photos scheduled for deletion (retention view). */
export async function pendingDeletion(limit = 50): Promise<Record<string, unknown>> {
  const scans = await EyeScan.find({ rawDeleteAt: { $exists: true, $ne: null } })
    .sort({ rawDeleteAt: 1 })
    .limit(limit)
    .populate<{ userId: { email?: string } | null }>('userId', 'email');

  const now = Date.now();
  const photos = await Promise.all(
    scans.map(async (s) => ({
      scanId: s._id.toString(),
      thumbnailUrl: s.images.front?.thumb ? await getSignedUrl(s.images.front.thumb) : null,
      userEmail:
        s.userId && typeof s.userId === 'object' && 'email' in s.userId
          ? (s.userId as { email?: string }).email ?? null
          : null,
      deleteAt: s.rawDeleteAt ?? null,
      ageHours: Math.max(0, Math.round((now - new Date(s.createdAt).getTime()) / 3_600_000)),
    })),
  );
  return { photos };
}

/* --------------------------- Subscriptions ----------------------------- */

export async function listSubscriptions(opts: {
  plan?: string;
  page: number;
  limit: number;
}): Promise<Paginated<Record<string, unknown>>> {
  const query: Record<string, unknown> = {
    'subscription.status': { $in: ['active', 'trial', 'expired'] },
  };
  if (opts.plan) query['subscription.plan'] = opts.plan;

  const [total, users] = await Promise.all([
    User.countDocuments(query),
    User.find(query)
      .sort({ 'subscription.expiresAt': -1 })
      .skip((opts.page - 1) * opts.limit)
      .limit(opts.limit)
      .select('email subscription'),
  ]);

  const data = users.map((u) => ({
    userId: u._id.toString(),
    email: u.email,
    status: u.subscription.status,
    plan: u.subscription.plan ?? null,
    expiresAt: u.subscription.expiresAt ?? null,
  }));

  return paginate(data, opts.page, total, opts.limit);
}

export async function refreshSubscription(userId: string): Promise<Record<string, unknown>> {
  return refreshFromRevenueCat(userId);
}

export async function subscriptionStats(): Promise<Record<string, unknown>> {
  const [activeCount, trialCount, expiredCount, monthlyCount, annualCount] = await Promise.all([
    User.countDocuments({ 'subscription.status': 'active' }),
    User.countDocuments({ 'subscription.status': 'trial' }),
    User.countDocuments({ 'subscription.status': 'expired' }),
    User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'monthly' }),
    User.countDocuments({ 'subscription.status': 'active', 'subscription.plan': 'annual' }),
  ]);
  const mrr =
    Math.round((monthlyCount * PRICE_MONTHLY + annualCount * PRICE_ANNUAL_MONTHLY_EQ) * 100) / 100;
  return { activeCount, trialCount, expiredCount, monthlyCount, annualCount, mrr };
}

/* ----------------------------- Exercises ------------------------------- */

export async function listExercises(): Promise<Record<string, unknown>[]> {
  const exercises = await Exercise.find().sort({ order: 1 });
  return exercises.map((e) => ({
    id: e.exerciseId,
    title: e.title,
    description: e.description,
    whyItHelps: e.whyItHelps,
    bestFor: e.bestFor,
    cautions: e.cautions,
    durationSec: e.durationSec,
    steps: e.steps,
    stepDurationsSec: e.stepDurationsSec,
    category: e.category,
    premium: e.premium,
    order: e.order,
  }));
}

export async function updateExercise(
  exerciseId: string,
  patch: {
    title?: string;
    description?: string;
    whyItHelps?: string;
    bestFor?: string;
    cautions?: string;
    steps?: string[];
    stepDurationsSec?: number[];
    durationSec?: number;
    category?: string;
    premium?: boolean;
    order?: number;
  },
): Promise<Record<string, unknown>> {
  const exercise = await Exercise.findOne({ exerciseId });
  if (!exercise) throw new AppError(404, 'Exercise not found', 'EXERCISE_NOT_FOUND');
  Object.assign(exercise, patch);
  await exercise.save();
  return { id: exercise.exerciseId, ...patch };
}

/* ------------------------- GDPR / Notifications ------------------------ */

export async function gdprRequests(): Promise<Record<string, unknown>> {
  const jobs = await getExportQueue().getJobs(
    ['waiting', 'active', 'completed', 'failed'],
    0,
    50,
  );
  const exports = await Promise.all(
    jobs.map(async (j) => ({
      jobId: j.id,
      userId: j.data.userId,
      status: await j.getState(),
      createdAt: j.timestamp ? new Date(j.timestamp) : null,
    })),
  );
  // Deletions run synchronously (immediate cascade), so there is no queue.
  return { exports, deletions: 'processed synchronously on request' };
}

const SEGMENT_LABEL: Record<string, string> = {
  all: 'All users',
  premium: 'Premium users',
  free: 'Free users',
  trial: 'Trial users',
};

/** Estimate how many users a send would target (best-effort, pre-token filter). */
export async function estimateAudience(opts: {
  userId?: string;
  segment?: 'all' | 'premium' | 'free' | 'trial';
}): Promise<Record<string, unknown>> {
  if (opts.userId) return { count: 1 };
  if (!opts.segment) return { count: 0 };
  const count = await User.countDocuments(notifications.segmentQuery(opts.segment as Segment));
  return { count };
}

export async function sendNotification(
  opts: {
    userId?: string;
    segment?: 'all' | 'premium' | 'free' | 'trial';
    title: string;
    body: string;
    data?: Record<string, string>;
  },
  adminId?: string,
): Promise<Record<string, unknown>> {
  const payload = { title: opts.title, body: opts.body, data: opts.data };

  async function log(audienceLabel: string, recipientCount: number): Promise<void> {
    await AdminNotificationLog.create({
      title: opts.title,
      body: opts.body,
      audienceLabel,
      segment: opts.segment,
      userId: opts.userId,
      recipientCount,
      sentByAdminId: adminId,
    });
  }

  // Single user: send synchronously (fast, one multicast).
  if (opts.userId) {
    const result = await notifications.sendPush(opts.userId, payload, {
      category: 'results',
      transactional: true,
    });
    await log('Single user', 1);
    return { mode: 'direct', targeted: 1, result };
  }

  // Segment: fan out off the request thread via the broadcast queue, which
  // sends in FCM multicast batches. Returns immediately with the job id.
  const jobId = await enqueueBroadcast({ segment: opts.segment as Segment, payload });
  const est = await estimateAudience({ segment: opts.segment });
  await log(SEGMENT_LABEL[opts.segment ?? 'all'] ?? 'Segment', Number(est.count) || 0);
  return { mode: 'queued', jobId, segment: opts.segment };
}

/** Paginated history of admin-sent notifications. */
export async function notificationHistory(opts: {
  page: number;
  limit: number;
}): Promise<Paginated<Record<string, unknown>>> {
  const [total, rows] = await Promise.all([
    AdminNotificationLog.countDocuments(),
    AdminNotificationLog.find()
      .sort({ createdAt: -1 })
      .skip((opts.page - 1) * opts.limit)
      .limit(opts.limit),
  ]);
  const data = rows.map((r) => ({
    id: r._id.toString(),
    title: r.title,
    body: r.body,
    audienceLabel: r.audienceLabel,
    recipientCount: r.recipientCount,
    sentAt: r.createdAt,
  }));
  return paginate(data, opts.page, total, opts.limit);
}

/* ----------------------------- Failed jobs ----------------------------- */

interface JobView {
  id: string | null;
  type: string;
  failureReason: string | null;
  failedAt: Date | null;
  scan?: { id: string };
}

export async function listJobs(opts: {
  status?: 'failed' | 'active' | 'waiting' | 'completed';
  limit?: number;
}): Promise<Record<string, unknown>> {
  const status = opts.status ?? 'failed';
  const limit = opts.limit ?? 50;
  const queue = getAnalyzeQueue();
  const jobs = await queue.getJobs([status], 0, limit - 1);
  const data: JobView[] = jobs.map((j) => ({
    id: j.id ?? null,
    type: 'analyze-eye-scan',
    failureReason: j.failedReason ?? null,
    failedAt: j.finishedOn ? new Date(j.finishedOn) : j.timestamp ? new Date(j.timestamp) : null,
    scan: j.data?.scanId ? { id: j.data.scanId } : undefined,
  }));
  return { jobs: data, total: data.length };
}

export async function retryJob(jobId: string): Promise<Record<string, unknown>> {
  const job = await getAnalyzeQueue().getJob(jobId);
  if (!job) throw new AppError(404, 'Job not found', 'JOB_NOT_FOUND');
  await job.retry();
  return { id: jobId, retried: true };
}

export async function retryAllFailed(): Promise<Record<string, unknown>> {
  const jobs = await getAnalyzeQueue().getJobs(['failed'], 0, 999);
  let retried = 0;
  for (const job of jobs) {
    try {
      await job.retry();
      retried += 1;
    } catch {
      // Skip jobs that are no longer retryable.
    }
  }
  return { retried };
}

export async function systemHealth(): Promise<Record<string, unknown>> {
  const [analyzeCounts, exportCounts, s3Ok] = await Promise.all([
    getAnalyzeQueue().getJobCounts('waiting', 'active', 'failed'),
    getExportQueue().getJobCounts('waiting', 'active', 'failed'),
    s3Ping(),
  ]);

  let redisOk = false;
  try {
    redisOk = (await getRedis().ping()) === 'PONG';
  } catch {
    redisOk = false;
  }

  return {
    mongo: mongoose.connection.readyState === 1 ? 'up' : 'down',
    redis: redisOk ? 'up' : 'down',
    s3: s3Ok ? 'up' : 'down',
    openai: env.OPENAI_API_KEY ? 'configured' : 'not_configured',
    revenuecat: env.REVENUECAT_API_KEY ? 'configured' : 'not_configured',
    queues: {
      analyze: analyzeCounts,
      export: exportCounts,
    },
  };
}
