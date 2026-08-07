import { createApp } from './app';
import { connectDB, disconnectDB, syncIndexes } from './config/db';
import { env } from './config/env';
import { logger } from './utils/logger';
import { startWorkers, RunningWorkers } from './jobs/workers';
import { closeRedis } from './config/redis';
import { installProcessGuards } from './utils/processGuards';

async function bootstrap(): Promise<void> {
  installProcessGuards('api');

  await connectDB();
  // Reconcile indexes with the current schemas (e.g. EB-13's sparse email index).
  await syncIndexes();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`eyesection-api listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  // Background workers run inline unless a dedicated worker process is used
  // (WORKER_MODE=separate → run `npm run start:worker`).
  let workers: RunningWorkers | null = null;
  if (env.WORKER_MODE !== 'separate') {
    workers = await startWorkers();
  } else {
    logger.info('WORKER_MODE=separate — API will not run background workers');
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down…`);
    server.close(async () => {
      if (workers) await workers.close();
      await closeRedis();
      await disconnectDB();
      process.exit(0);
    });
    // Force-exit if graceful shutdown stalls.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
