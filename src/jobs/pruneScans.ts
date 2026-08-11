/**
 * One-off cleanup: keep only the N most recent EyeScans and delete the rest,
 * including their S3 photos (raw / thumb / eyeThumb for front & closeup).
 *
 * ⚠️  DESTRUCTIVE. Without USER_ID this prunes scans ACROSS THE WHOLE PLATFORM.
 * Multiple guards must be cleared before anything is deleted:
 *   - --dry-run always previews without deleting (safe default to start with).
 *   - A real delete requires the confirmation token CONFIRM_PRUNE=DELETE.
 *   - Running against NODE_ENV=production additionally requires ALLOW_PROD_PRUNE=yes.
 *   - USER_ID=<id> scopes the prune to a single user (strongly recommended).
 *
 * Usage:
 *   ts-node-dev --transpile-only src/jobs/pruneScans.ts --dry-run           # preview
 *   USER_ID=<id> KEEP=2 CONFIRM_PRUNE=DELETE ts-node-dev ... pruneScans.ts  # one user
 *   CONFIRM_PRUNE=DELETE ts-node-dev ... pruneScans.ts                      # ALL users (careful)
 *   KEEP=2 ts-node-dev --transpile-only src/jobs/pruneScans.ts             # change how many to keep
 */
import { Types } from 'mongoose';
import { connectDB, disconnectDB } from '../config/db';
import { EyeScan } from '../models/EyeScan';
import { deleteMany } from '../services/s3.service';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const KEEP = Math.max(0, Number(process.env.KEEP ?? 2));
const DRY_RUN = process.argv.includes('--dry-run');
const USER_ID = process.env.USER_ID?.trim() || undefined;
const CONFIRMED = process.env.CONFIRM_PRUNE === 'DELETE';
const PROD_ALLOWED = process.env.ALLOW_PROD_PRUNE === 'yes';

function s3KeysFor(scan: {
  images?: { front?: Record<string, string>; closeup?: Record<string, string> };
}): string[] {
  const { front, closeup } = scan.images ?? {};
  return [
    front?.raw,
    front?.thumb,
    front?.eyeThumb,
    closeup?.raw,
    closeup?.thumb,
    closeup?.eyeThumb,
  ].filter((k): k is string => !!k);
}

/** Bail out unless every guard for a real (non-dry-run) delete is satisfied. */
function assertAllowedToDelete(): void {
  if (DRY_RUN) return;
  if (!CONFIRMED) {
    throw new Error(
      'Refusing to delete without confirmation. Re-run with --dry-run to preview, ' +
        'or set CONFIRM_PRUNE=DELETE to actually delete.',
    );
  }
  if (env.NODE_ENV === 'production' && !PROD_ALLOWED) {
    throw new Error(
      'Refusing to run a destructive prune against NODE_ENV=production. ' +
        'Set ALLOW_PROD_PRUNE=yes only if you are absolutely certain.',
    );
  }
  if (!USER_ID) {
    logger.warn(
      '[pruneScans] No USER_ID set — this will prune scans across the ENTIRE platform.',
    );
  }
}

async function pruneScans(): Promise<void> {
  if (USER_ID && !Types.ObjectId.isValid(USER_ID)) {
    throw new Error(`USER_ID is not a valid ObjectId: ${USER_ID}`);
  }
  assertAllowedToDelete();

  await connectDB();
  try {
    const filter = USER_ID ? { userId: new Types.ObjectId(USER_ID) } : {};
    const scope = USER_ID ? `user=${USER_ID}` : 'PLATFORM-WIDE';
    const total = await EyeScan.countDocuments(filter);

    // Newest first; the first KEEP survive, everything after is deleted.
    const doomed = await EyeScan.find(filter)
      .sort({ createdAt: -1 })
      .skip(KEEP)
      .select('_id createdAt images');

    logger.info(
      `[pruneScans] scope=${scope} total=${total} keep=${KEEP} toDelete=${doomed.length} dryRun=${DRY_RUN}`,
    );

    if (doomed.length === 0) {
      logger.info('[pruneScans] nothing to delete');
      return;
    }

    const ids = doomed.map((s) => s._id);
    const keys = doomed.flatMap((s) => s3KeysFor(s as never));
    logger.info(`[pruneScans] will remove ${ids.length} scans and ${keys.length} S3 objects`);

    if (DRY_RUN) {
      logger.info('[pruneScans] DRY RUN — no changes made');
      return;
    }

    if (keys.length > 0) await deleteMany(keys);
    const res = await EyeScan.deleteMany({ _id: { $in: ids } });
    logger.info(`[pruneScans] deleted ${res.deletedCount} scans, ${keys.length} S3 objects`);
    logger.info(`[pruneScans] remaining scans (${scope}): ${await EyeScan.countDocuments(filter)}`);
  } finally {
    await disconnectDB();
  }
}

pruneScans().catch((err) => {
  logger.error('[pruneScans] failed', err);
  process.exit(1);
});
