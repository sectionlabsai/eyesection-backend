import { Queue, Worker, JobsOptions, Job } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';
import { runExport } from '../services/gdpr.service';

/**
 * GDPR data-export queue (EB-11). Exports can be large, so they run off the
 * request in a BullMQ job — mirrors the analysis queue (src/config/queue.ts).
 */
export const EXPORT_QUEUE = 'gdpr-export';

export interface ExportJobData {
  userId: string;
}

export interface ExportJobResult {
  url: string;
  key: string;
}

function makeConnection(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

let queue: Queue<ExportJobData> | null = null;

export function getExportQueue(): Queue<ExportJobData> {
  if (!queue) {
    queue = new Queue<ExportJobData>(EXPORT_QUEUE, { connection: makeConnection() });
  }
  return queue;
}

const JOB_OPTS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 }, // keep results queryable for 7 days
  removeOnFail: 100,
};

export async function enqueueExport(userId: string): Promise<string> {
  const job = await getExportQueue().add('export', { userId }, JOB_OPTS);
  return job.id as string;
}

export function startExportWorker(): Worker<ExportJobData, ExportJobResult> {
  const worker = new Worker<ExportJobData, ExportJobResult>(
    EXPORT_QUEUE,
    async (job: Job<ExportJobData>) => runExport(job.data.userId),
    { connection: makeConnection(), concurrency: 2 },
  );

  worker.on('failed', (job, err) =>
    logger.error(`[gdpr-export] job ${job?.id} failed`, err),
  );
  worker.on('completed', (job) =>
    logger.info(`[gdpr-export] job ${job.id} completed`),
  );
  return worker;
}
