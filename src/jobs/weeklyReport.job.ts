import { EyeScan, ComfortEntry } from '../models';
import { lastCompletedWeek, upsertWeeklyReport } from '../services/report.service';
import { logger } from '../utils/logger';

/**
 * Weekly report builder. Runs daily and, for the most recently completed week,
 * generates a Report for every user who was active that week (a scan or a
 * comfort entry). Idempotent — upsertWeeklyReport keys on {user, weekStart}, so
 * re-running the same day just refreshes existing reports.
 */
export async function runWeeklyReportBuild(now = new Date()): Promise<number> {
  const { start, end } = lastCompletedWeek(now);

  // Users active in the window, from either signal.
  const [scanUsers, entryUsers] = await Promise.all([
    EyeScan.distinct('userId', {
      status: 'complete',
      createdAt: { $gte: start, $lt: end },
    }),
    ComfortEntry.distinct('userId', { date: { $gte: start, $lt: end } }),
  ]);

  const userIds = new Set<string>();
  for (const id of scanUsers) if (id) userIds.add(id.toString());
  for (const id of entryUsers) if (id) userIds.add(id.toString());

  let built = 0;
  for (const userId of userIds) {
    try {
      const report = await upsertWeeklyReport(userId, start, end);
      if (report) built += 1;
    } catch (err) {
      logger.error(`Weekly report failed for user ${userId}`, err);
    }
  }

  if (built > 0) {
    logger.info(
      `Weekly report build: ${built} report(s) for week starting ${start.toISOString().slice(0, 10)}`,
    );
  }
  return built;
}
// Scheduling is handled by the BullMQ maintenance queue (config/maintenanceQueue.ts).
