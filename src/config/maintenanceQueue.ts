import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';
import { runRetentionSweep } from '../jobs/retention.job';
import { runWeeklyReportBuild } from '../jobs/weeklyReport.job';
import { runAnonCleanup } from '../jobs/anonCleanup.job';

/**
 * Scheduled maintenance (EB-04 retention sweep, EB-09 weekly reports) as BullMQ
 * REPEATABLE jobs rather than in-process setInterval timers. This guarantees a
 * single execution per interval across ANY number of API/worker instances —
 * in-process timers would fire once per instance and duplicate the work.
 */
export const MAINTENANCE_QUEUE = 'maintenance';

export const MAINTENANCE_JOBS = {
  retention: 'retention-sweep',
  weeklyReport: 'weekly-report',
  anonCleanup: 'anon-cleanup',
} as const;

const RETENTION_EVERY_MS = 30 * 60 * 1000; // every 30 minutes
const WEEKLY_REPORT_EVERY_MS = 24 * 60 * 60 * 1000; // once per day
const ANON_CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000; // once per day

function makeConnection(): IORedis {
  // family:0 = dual-stack DNS so Railway's IPv6-only redis.railway.internal
  // resolves; harmless for localhost / public URLs.
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, family: 0 });
}

let queue: Queue | null = null;

export function getMaintenanceQueue(): Queue {
  if (!queue) {
    queue = new Queue(MAINTENANCE_QUEUE, { connection: makeConnection() });
  }
  return queue;
}

/**
 * Register the repeatable schedules (idempotent — BullMQ dedupes by repeat key)
 * and kick off one immediate run of each so a fresh deploy backfills without
 * waiting a full interval. Both handlers are idempotent, so the extra run is safe.
 */
export async function scheduleMaintenanceJobs(): Promise<void> {
  const q = getMaintenanceQueue();

  await q.add(MAINTENANCE_JOBS.retention, {}, {
    repeat: { every: RETENTION_EVERY_MS },
    jobId: MAINTENANCE_JOBS.retention,
    removeOnComplete: true,
    removeOnFail: 50,
  });
  await q.add(MAINTENANCE_JOBS.weeklyReport, {}, {
    repeat: { every: WEEKLY_REPORT_EVERY_MS },
    jobId: MAINTENANCE_JOBS.weeklyReport,
    removeOnComplete: true,
    removeOnFail: 50,
  });
  await q.add(MAINTENANCE_JOBS.anonCleanup, {}, {
    repeat: { every: ANON_CLEANUP_EVERY_MS },
    jobId: MAINTENANCE_JOBS.anonCleanup,
    removeOnComplete: true,
    removeOnFail: 50,
  });

  // Immediate boot-time runs (retention purges promptly; reports backfill).
  await q.add(MAINTENANCE_JOBS.retention, {}, { removeOnComplete: true, removeOnFail: 50 });
  await q.add(MAINTENANCE_JOBS.weeklyReport, {}, { removeOnComplete: true, removeOnFail: 50 });

  logger.info(
    'Maintenance jobs scheduled (retention 30m, weekly report daily, anon cleanup daily)',
  );
}

export function startMaintenanceWorker(): Worker {
  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async (job: Job) => {
      if (job.name === MAINTENANCE_JOBS.retention) return runRetentionSweep();
      if (job.name === MAINTENANCE_JOBS.weeklyReport) return runWeeklyReportBuild();
      if (job.name === MAINTENANCE_JOBS.anonCleanup) return runAnonCleanup();
      logger.warn(`[maintenance] unknown job ${job.name}`);
    },
    { connection: makeConnection(), concurrency: 1 },
  );

  worker.on('failed', (job, err) =>
    logger.error(`[maintenance] job ${job?.name} failed`, err),
  );
  return worker;
}
