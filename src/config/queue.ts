import { Queue, Worker, JobsOptions, Job } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';
import { processScan } from '../services/analysis/pipeline.service';

/**
 * BullMQ needs a dedicated Redis connection with maxRetriesPerRequest:null,
 * so it does not share the app's shared client (src/config/redis.ts).
 */
export const ANALYZE_QUEUE = 'analyze-eye-scan';

export interface AnalyzeJobData {
  scanId: string;
}

function makeConnection(): IORedis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

let queue: Queue<AnalyzeJobData> | null = null;

export function getAnalyzeQueue(): Queue<AnalyzeJobData> {
  if (!queue) {
    queue = new Queue<AnalyzeJobData>(ANALYZE_QUEUE, { connection: makeConnection() });
  }
  return queue;
}

const DEFAULT_JOB_OPTS: JobsOptions = {
  attempts: 3, // 1 try + 2 retries
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

export async function enqueueAnalyzeScan(scanId: string): Promise<void> {
  await getAnalyzeQueue().add('analyze', { scanId }, DEFAULT_JOB_OPTS);
}

/**
 * Starts the analysis worker (EB-05 pipeline). Concurrency 3.
 * The handler itself never throws for expected/analysis failures — those are
 * recorded on the scan as status 'failed'; it only throws for infrastructure
 * errors so BullMQ retries them.
 */
export function startAnalyzeWorker(): Worker<AnalyzeJobData> {
  const worker = new Worker<AnalyzeJobData>(
    ANALYZE_QUEUE,
    async (job: Job<AnalyzeJobData>) => {
      await processScan(job.data.scanId);
    },
    { connection: makeConnection(), concurrency: 3 },
  );

  worker.on('failed', (job, err) =>
    logger.error(`[analyze-eye-scan] job ${job?.id} failed`, err),
  );
  worker.on('completed', (job) =>
    logger.info(`[analyze-eye-scan] job ${job.id} completed`),
  );
  return worker;
}
