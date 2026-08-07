import { User } from '../models';
import { deleteAccount } from '../services/gdpr.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Retention for anonymous-first users (EB-13). Anonymous sessions that were
 * never upgraded and have been idle past the TTL (env `ANON_TTL_DAYS`, default
 * 30) are purged via the same GDPR cascade real accounts use (S3 objects + all
 * documents + token revocation), so we never accumulate orphaned anonymous data.
 */
export async function runAnonCleanup(): Promise<number> {
  const cutoff = new Date(Date.now() - env.ANON_TTL_DAYS * 24 * 60 * 60 * 1000);

  const stale = await User.find({
    isAnonymous: true,
    createdAt: { $lt: cutoff },
    $or: [{ lastActiveAt: { $exists: false } }, { lastActiveAt: { $lt: cutoff } }],
  }).select('_id');

  let removed = 0;
  for (const u of stale) {
    try {
      await deleteAccount(u._id.toString());
      removed += 1;
    } catch (err) {
      // Leave the user in place so the next sweep retries.
      logger.error(`Anon cleanup: failed to delete user ${u._id}`, err);
    }
  }

  if (removed > 0) logger.info(`Anon cleanup removed ${removed} stale anonymous user(s)`);
  return removed;
}
