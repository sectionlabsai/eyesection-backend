import { Worker } from 'bullmq';
import { startAnalyzeWorker } from '../config/queue';
import { startExportWorker } from '../config/exportQueue';
import { startBroadcastWorker } from '../config/broadcastQueue';
import {
  startMaintenanceWorker,
  scheduleMaintenanceJobs,
} from '../config/maintenanceQueue';
import { logger } from '../utils/logger';

/**
 * Starts every background worker (analysis, GDPR export, admin broadcast,
 * scheduled maintenance) and registers the repeatable maintenance schedules.
 *
 * Runs either inside the API process (WORKER_MODE=inline, for dev / single node)
 * or in the dedicated worker entrypoint (src/worker.ts, WORKER_MODE=separate).
 */
export interface RunningWorkers {
  close: () => Promise<void>;
}

export async function startWorkers(): Promise<RunningWorkers> {
  // Register repeatable schedules first (idempotent).
  await scheduleMaintenanceJobs();

  const workers: Worker[] = [
    startAnalyzeWorker(),
    startExportWorker(),
    startBroadcastWorker(),
    startMaintenanceWorker(),
  ];

  logger.info(`Background workers started (${workers.length})`);

  return {
    close: async () => {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
