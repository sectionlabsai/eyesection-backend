import { Queue, Worker, JobsOptions, Job } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';
import { broadcastToSegment, Segment, PushPayload } from '../services/notification.service';

/**
 * Admin segment broadcasts (EB-12). Sending to a large segment can take a while,
 * so it runs off the HTTP request in a BullMQ job that fans out via FCM
 * multicast batches (see notification.service.broadcastToSegment).
 */
export const BROADCAST_QUEUE = 'admin-broadcast';

export interface BroadcastJobData {
  segment: Segment;
  payload: PushPayload;
}

function makeConnection(): IORedis {
  // family:0 = dual-stack DNS so Railway's IPv6-only redis.railway.internal
  // resolves; harmless for localhost / public URLs.
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, family: 0 });
}

let queue: Queue<BroadcastJobData> | null = null;

export function getBroadcastQueue(): Queue<BroadcastJobData> {
  if (!queue) {
    queue = new Queue<BroadcastJobData>(BROADCAST_QUEUE, { connection: makeConnection() });
  }
  return queue;
}

const JOB_OPTS: JobsOptions = {
  attempts: 1, // don't re-blast a segment on transient failure
  removeOnComplete: 100,
  removeOnFail: 100,
};

export async function enqueueBroadcast(data: BroadcastJobData): Promise<string> {
  const job = await getBroadcastQueue().add('broadcast', data, JOB_OPTS);
  return job.id as string;
}

export function startBroadcastWorker(): Worker<BroadcastJobData> {
  const worker = new Worker<BroadcastJobData>(
    BROADCAST_QUEUE,
    async (job: Job<BroadcastJobData>) =>
      broadcastToSegment(job.data.segment, job.data.payload),
    { connection: makeConnection(), concurrency: 1 },
  );

  worker.on('failed', (job, err) =>
    logger.error(`[admin-broadcast] job ${job?.id} failed`, err),
  );
  return worker;
}
