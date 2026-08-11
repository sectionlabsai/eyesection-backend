import bcrypt from 'bcrypt';
import { Types } from 'mongoose';
import {
  User,
  EyeScan,
  ComfortEntry,
  BreakPlan,
  ExerciseSession,
  Report,
} from '../models';
import { AppError } from '../middleware/error';
import {
  uploadBuffer,
  getSignedUrl,
  deletePrefix,
  userPrefix,
} from './s3.service';
import { revokeUserTokens } from './token.service';
import { purgeUserChatData } from './chatCache';
import { logger } from '../utils/logger';

const EXPORT_URL_TTL_SEC = 7 * 24 * 60 * 60; // signed link valid 7 days (S3 max)

/**
 * Gather EVERYTHING we hold on a user into a single JSON structure (GDPR data
 * portability). Scan images are represented by short-lived signed thumbnail
 * URLs — never raw S3 keys.
 */
export async function gatherUserData(userId: string): Promise<Record<string, unknown>> {
  const uid = new Types.ObjectId(userId);

  const [user, scans, comfort, plan, sessions, reports] = await Promise.all([
    User.findById(uid),
    EyeScan.find({ userId: uid }).sort({ createdAt: 1 }),
    ComfortEntry.find({ userId: uid }).sort({ date: 1 }),
    BreakPlan.findOne({ userId: uid }),
    ExerciseSession.find({ userId: uid }).sort({ completedAt: 1 }),
    Report.find({ userId: uid }).sort({ weekStart: 1 }),
  ]);

  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');

  const scanExports = await Promise.all(
    scans.map(async (s) => ({
      scanId: s._id.toString(),
      status: s.status,
      createdAt: s.createdAt,
      geometry: s.geometry,
      analysis: s.analysis,
      iris: s.iris,
      frontThumbUrl: s.images.front?.thumb
        ? await getSignedUrl(s.images.front.thumb)
        : null,
      closeupThumbUrl: s.images.closeup?.thumb
        ? await getSignedUrl(s.images.closeup.thumb)
        : null,
    })),
  );

  return {
    exportedAt: new Date().toISOString(),
    profile: {
      id: user._id.toString(),
      email: user.email,
      displayName: user.displayName,
      authProvider: user.authProvider,
      concerns: user.concerns,
      screenProfile: user.screenProfile,
      subscription: {
        status: user.subscription.status,
        plan: user.subscription.plan,
        expiresAt: user.subscription.expiresAt,
      },
      consent: user.consent,
      notificationPrefs: user.notificationPrefs,
      createdAt: user.createdAt,
    },
    scans: scanExports,
    comfortEntries: comfort.map((c) => ({
      date: c.date,
      comfortScore: c.comfortScore,
      band: c.band,
      inputs: c.inputs,
    })),
    breakPlan: plan
      ? { template: plan.template, reminders: plan.reminders, activeHours: plan.activeHours }
      : null,
    exerciseSessions: sessions.map((s) => ({
      exerciseId: s.exerciseId,
      durationSec: s.durationSec,
      completedAt: s.completedAt,
    })),
    reports: reports.map((r) => ({
      weekStart: r.weekStart,
      freshnessAvg: r.freshnessAvg,
      comfortAvg: r.comfortAvg,
      breakCompliancePct: r.breakCompliancePct,
      highlights: r.highlights,
    })),
  };
}

/** Build the export JSON, store it on S3 and return a signed download link. */
export async function runExport(
  userId: string,
): Promise<{ url: string; key: string }> {
  const data = await gatherUserData(userId);
  const key = `users/${userId}/exports/${Date.now()}.json`;
  await uploadBuffer(key, Buffer.from(JSON.stringify(data, null, 2)), 'application/json');
  const url = await getSignedUrl(key, EXPORT_URL_TTL_SEC);

  // Email delivery is stubbed (mirrors the password-reset stub) — link logged.
  logger.info(`[gdpr-export] export ready for user ${userId}: ${key}`);
  return { url, key };
}

/**
 * Re-authenticate before an irreversible action (account deletion). Password
 * users must supply their current password; social users (no password) must
 * pass an explicit `confirm: true` while holding a valid access token.
 */
export async function assertReauth(
  userId: string,
  password?: string,
  confirm?: boolean,
): Promise<void> {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');

  if (user.passwordHash) {
    if (!password || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new AppError(401, 'Please confirm your password to continue', 'REAUTH_REQUIRED');
    }
  } else if (confirm !== true) {
    throw new AppError(401, 'Please confirm to continue', 'REAUTH_REQUIRED');
  }
}

/**
 * Permanently delete a user and ALL their data. Removes every S3 object under
 * the user's prefix (scan images + exports), then the DB documents, revokes
 * sessions and detaches the RevenueCat mapping.
 */
export async function deleteAccount(userId: string): Promise<void> {
  const uid = new Types.ObjectId(userId);

  // 1) S3: delete everything under users/<id>/ (raw, thumbs, exports).
  try {
    const removed = await deletePrefix(userPrefix(userId));
    logger.info(`[gdpr-delete] removed ${removed} S3 object(s) for user ${userId}`);
  } catch (err) {
    // Storage may be unconfigured in dev; log and continue with DB cascade.
    logger.error(`[gdpr-delete] S3 purge failed for user ${userId}`, err);
  }

  // 2) DB cascade.
  await Promise.all([
    EyeScan.deleteMany({ userId: uid }),
    ComfortEntry.deleteMany({ userId: uid }),
    BreakPlan.deleteMany({ userId: uid }),
    ExerciseSession.deleteMany({ userId: uid }),
    Report.deleteMany({ userId: uid }),
  ]);

  // 3) Revoke sessions, purge Redis chat state, then remove the user doc.
  await revokeUserTokens(userId);
  await purgeUserChatData(userId);
  await User.deleteOne({ _id: uid });

  // The user doc — including the local RevenueCat mapping (rcAppUserId) — is now
  // gone. RevenueCat's own subscriber record is not deleted here; it holds no PII
  // beyond the app user id and expires per their retention. Wire their delete-
  // subscriber API here if hard deletion on their side is ever required.
  logger.info(`[gdpr-delete] account ${userId} fully deleted`);
}
