import { Types } from 'mongoose';
import { EyeScan, IEyeScan } from '../models/EyeScan';
import { User } from '../models/User';
import { AppError } from '../middleware/error';
import { processEyeImage } from './image.service';
import { uploadBuffer, getSignedUrl, scanKey, deleteMany } from './s3.service';
import { enqueueAnalyzeScan } from '../config/queue';
import { isPremium } from './entitlement.service';
import { logger } from '../utils/logger';

/** Guests and free accounts get exactly one successful/in-flight scan. */
const FREE_SCAN_LIMIT = 1;

/**
 * Non-premium users (anonymous guests + registered free) may create only one
 * non-failed scan. Premium users are unlimited.
 */
async function assertFreeScanAllowance(userId?: string): Promise<void> {
  if (!userId) return; // truly unauthenticated upload — rare; client always auths

  const user = await User.findById(userId).select('subscription');
  if (user && isPremium(user)) return;

  const used = await EyeScan.countDocuments({
    userId: new Types.ObjectId(userId),
    status: { $in: ['pending', 'processing', 'complete'] },
  });
  if (used >= FREE_SCAN_LIMIT) {
    throw new AppError(
      402,
      'You’ve used your free scan. Upgrade to Premium for unlimited scans.',
      'FREE_SCAN_LIMIT',
    );
  }
}

const RAW_RETENTION_MS = 24 * 60 * 60 * 1000; // raw photos deleted within 24h

export interface Geometry {
  eyeOpennessL?: number;
  eyeOpennessR?: number;
  symmetry?: number;
  [key: string]: unknown; // crop rectangles, landmarks — persisted verbatim
}

export interface UploadInput {
  userId?: string; // undefined => anonymous first scan
  front: Buffer;
  closeup?: Buffer;
  geometry: Geometry;
}

/** Decode a base64 (optionally data-URL) string into a Buffer. */
export function decodeBase64Image(value: string): Buffer {
  const cleaned = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.length === 0) throw new AppError(400, 'Invalid image data', 'IMAGE_INVALID');
  return buf;
}

/**
 * Hard guard — the client should prevent submitting a photo with no detectable
 * eye region, but we double-check geometry presence here (kept friendly).
 */
function assertGeometryPresent(geometry: Geometry): void {
  const hasOpenness =
    typeof geometry.eyeOpennessL === 'number' || typeof geometry.eyeOpennessR === 'number';
  if (!geometry || Object.keys(geometry).length === 0 || !hasOpenness) {
    throw new AppError(422, "We couldn't read the eyes in that photo", 'NO_EYE_REGION');
  }
}

/**
 * Best-effort compensation when a scan upload fails partway through. Deletes the
 * persisted scan doc (if any) and every S3 object already written. Cleanup
 * errors are logged but never mask the original failure the caller will throw.
 */
async function rollbackScan(
  scanId: Types.ObjectId,
  scanPersisted: boolean,
  uploadedKeys: string[],
): Promise<void> {
  try {
    if (scanPersisted) await EyeScan.deleteOne({ _id: scanId });
    if (uploadedKeys.length) await deleteMany(uploadedKeys);
    logger.warn(
      `Scan ${scanId} upload rolled back (removed ${uploadedKeys.length} object(s), doc=${scanPersisted})`,
    );
  } catch (cleanupErr) {
    logger.error(`Scan ${scanId} rollback failed — manual cleanup may be needed`, cleanupErr);
  }
}

export async function createScanFromUpload(input: UploadInput): Promise<{
  scanId: string;
  status: string;
}> {
  assertGeometryPresent(input.geometry);
  // Enforce before any image work / S3 writes so free-tier users can't burn
  // bandwidth after they've already spent their one scan.
  await assertFreeScanAllowance(input.userId);

  const scanId = new Types.ObjectId();
  const ownerId = input.userId || 'anon';

  // Process (validate + strip EXIF + thumbnail) before persisting anything.
  const front = await processEyeImage(input.front);
  const closeup = input.closeup ? await processEyeImage(input.closeup) : undefined;

  // Track every object we put in S3 and every side effect, so that if any later
  // step fails we can roll the whole upload back — no orphaned objects and no
  // scan doc stranded in 'pending' with nothing to process it.
  const uploadedKeys: string[] = [];
  let scanPersisted = false;

  try {
    const frontRawKey = scanKey(ownerId, scanId.toString(), 'front', 'raw');
    const frontThumbKey = scanKey(ownerId, scanId.toString(), 'front', 'thumb');
    await uploadBuffer(frontRawKey, front.raw, front.contentType);
    uploadedKeys.push(frontRawKey);
    await uploadBuffer(frontThumbKey, front.thumb, front.contentType);
    uploadedKeys.push(frontThumbKey);

    let closeupKeys: { raw: string; thumb: string } | undefined;
    if (closeup) {
      const rawKey = scanKey(ownerId, scanId.toString(), 'closeup', 'raw');
      const thumbKey = scanKey(ownerId, scanId.toString(), 'closeup', 'thumb');
      await uploadBuffer(rawKey, closeup.raw, closeup.contentType);
      uploadedKeys.push(rawKey);
      await uploadBuffer(thumbKey, closeup.thumb, closeup.contentType);
      uploadedKeys.push(thumbKey);
      closeupKeys = { raw: rawKey, thumb: thumbKey };
    }

    const scan = await EyeScan.create({
      _id: scanId,
      userId: input.userId ? new Types.ObjectId(input.userId) : undefined,
      status: 'pending',
      images: {
        front: { raw: frontRawKey, thumb: frontThumbKey },
        closeup: closeupKeys,
      },
      geometry: {
        eyeOpennessL: input.geometry.eyeOpennessL,
        eyeOpennessR: input.geometry.eyeOpennessR,
        symmetry: input.geometry.symmetry,
      },
      geometryRaw: input.geometry,
      rawDeleteAt: new Date(Date.now() + RAW_RETENTION_MS),
    });
    scanPersisted = true;

    // If enqueue fails the scan would never be analysed, so treat it as fatal
    // and let the rollback below delete the doc + objects.
    await enqueueAnalyzeScan(scan._id.toString());
    logger.info(`Scan ${scan._id} created (owner=${ownerId}) and queued for analysis`);

    return { scanId: scan._id.toString(), status: scan.status };
  } catch (err) {
    await rollbackScan(scanId, scanPersisted, uploadedKeys);
    throw err;
  }
}

/**
 * Signed-thumbnail view of a scan. Never exposes raw keys, and — because this is
 * an eye-wellness app — only ever exposes the EYE-REGION crop to the client. The
 * full-face thumbnail is retained for admin review but never returned here.
 */
async function toSignedView(scan: IEyeScan): Promise<Record<string, unknown>> {
  const eyeThumb = scan.images.front.eyeThumb
    ? await getSignedUrl(scan.images.front.eyeThumb)
    : null;
  const closeupThumb = scan.images.closeup?.thumb
    ? await getSignedUrl(scan.images.closeup.thumb)
    : null;

  return {
    scanId: scan._id.toString(),
    status: scan.status,
    images: { eyeThumbUrl: eyeThumb, closeupThumbUrl: closeupThumb },
    geometry: scan.geometry,
    analysis: scan.analysis,
    iris: scan.iris,
    createdAt: scan.createdAt,
  };
}

/**
 * Read a scan. A logged-in user may only read their own scans; an anonymous
 * scan (no userId) is readable by anyone holding the scanId.
 */
export async function getScan(
  scanId: string,
  requesterId?: string,
): Promise<Record<string, unknown>> {
  if (!Types.ObjectId.isValid(scanId)) {
    throw new AppError(404, 'Scan not found', 'SCAN_NOT_FOUND');
  }
  const scan = await EyeScan.findById(scanId);
  if (!scan) throw new AppError(404, 'Scan not found', 'SCAN_NOT_FOUND');

  if (scan.userId) {
    if (!requesterId || scan.userId.toString() !== requesterId) {
      throw new AppError(403, 'You do not have access to this scan', 'SCAN_FORBIDDEN');
    }
  }
  return toSignedView(scan);
}

/** Newest-first list of a user's completed scans (EB-05 history). */
const SCAN_HISTORY_LIMIT = 50;

export async function listScans(
  requesterId?: string,
): Promise<{ scans: Record<string, unknown>[] }> {
  // No identity → no history (an anonymous caller with no token owns nothing to
  // list). The client always holds at least an anonymous token, so this is rare.
  if (!requesterId) return { scans: [] };

  const scans = await EyeScan.find({ userId: requesterId, status: 'complete' })
    .sort({ createdAt: -1 })
    .limit(SCAN_HISTORY_LIMIT);

  const views = await Promise.all(scans.map((scan) => toSignedView(scan)));
  return { scans: views };
}
