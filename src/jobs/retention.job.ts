import { EyeScan } from '../models/EyeScan';
import { deleteMany } from '../services/s3.service';
import { logger } from '../utils/logger';

/**
 * Privacy retention: raw photos are deleted within 24h; thumbnails kept 90 days.
 * Finds scans whose rawDeleteAt has passed but still hold raw S3 keys, deletes
 * those raw objects (keeps thumbs), and clears the raw fields.
 */
export async function runRetentionSweep(): Promise<number> {
  const now = new Date();
  const scans = await EyeScan.find({
    rawDeleteAt: { $lte: now },
    $or: [
      { 'images.front.raw': { $exists: true, $ne: null } },
      { 'images.closeup.raw': { $exists: true, $ne: null } },
    ],
  });

  let cleared = 0;
  for (const scan of scans) {
    const keys: string[] = [];
    if (scan.images.front?.raw) keys.push(scan.images.front.raw);
    if (scan.images.closeup?.raw) keys.push(scan.images.closeup.raw);

    try {
      if (keys.length) await deleteMany(keys);
      if (scan.images.front) scan.images.front.raw = undefined;
      if (scan.images.closeup) scan.images.closeup.raw = undefined;
      scan.rawDeleteAt = undefined;
      await scan.save();
      cleared += 1;
    } catch (err) {
      // Leave rawDeleteAt set so the next sweep retries this scan.
      logger.error(`Retention: failed to purge raw for scan ${scan._id}`, err);
    }
  }

  if (cleared > 0) logger.info(`Retention sweep purged raw photos for ${cleared} scan(s)`);
  return cleared;
}
// Scheduling is handled by the BullMQ maintenance queue (config/maintenanceQueue.ts).
