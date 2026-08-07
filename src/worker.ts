import { connectDB, disconnectDB } from './config/db';
import { env } from './config/env';
import { logger } from './utils/logger';
import { startWorkers } from './jobs/workers';
import { closeRedis } from './config/redis';
import { installProcessGuards } from './utils/processGuards';

/**
 * Dedicated worker process. Run this separately from the API when
 * WORKER_MODE=separate so CPU-heavy analysis/export work does not compete with
 * request handling and can be scaled independently.
 *
 *   npm run start:worker   (prod)   |   npm run worker   (dev)
 */
async function bootstrap(): Promise<void> {
  installProcessGuards('worker');

  await connectDB();
  const workers = await startWorkers();
  logger.info(`eyesection worker started (${env.NODE_ENV})`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Worker received ${signal}, shutting down…`);
    await workers.close();
    await closeRedis();
    await disconnectDB();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error('Fatal worker startup error', err);
  process.exit(1);
});
