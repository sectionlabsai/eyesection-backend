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

export async function login(
  email: string,
  password: string,
): Promise<{ adminToken: string; admin: Record<string, unknown> }> {
  const admin = await AdminUser.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!admin) throw new AppError(401, 'Invalid credentials', 'ADMIN_INVALID_CREDENTIALS');
  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) throw new AppError(401, 'Invalid credentials', 'ADMIN_INVALID_CREDENTIALS');

  admin.lastLoginAt = new Date();
  await admin.save();

  return {
    adminToken: signAdminToken(admin._id.toString(), admin.role),
    admin: { id: admin._id.toString(), email: admin.email, role: admin.role },
  };
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

export async function sendNotification(opts: {
  userId?: string;
  segment?: 'all' | 'premium' | 'free' | 'trial';
  title: string;
  body: string;
  data?: Record<string, string>;
}): Promise<Record<string, unknown>> {
  const payload = { title: opts.title, body: opts.body, data: opts.data };

  // Single user: send synchronously (fast, one multicast).
  if (opts.userId) {
    const result = await notifications.sendPush(opts.userId, payload, {
      category: 'results',
      transactional: true,
    });
    return { mode: 'direct', targeted: 1, result };
  }

  // Segment: fan out off the request thread via the broadcast queue, which
  // sends in FCM multicast batches. Returns immediately with the job id.
  const jobId = await enqueueBroadcast({ segment: opts.segment as Segment, payload });
  return { mode: 'queued', jobId, segment: opts.segment };
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
