import { logger } from './logger';

/**
 * Last-resort process-level safety net.
 *
 * Without these handlers a single stray async throw (a rejected promise Express
 * never catches, a background job that throws outside its try/catch, etc.) is an
 * unhandled rejection — and under Node's default `--unhandled-rejections=throw`
 * that terminates the process with only Node's raw output.
 *
 * We log through our logger for observability. An uncaught exception leaves the
 * process in an unknown state, so we exit and let the orchestrator (systemd /
 * k8s / PM2) restart a clean instance; an unhandled rejection is logged loudly
 * but kept alive so one bad request can't take the server down.
 */
export function installProcessGuards(context: 'api' | 'worker'): void {
  process.on('unhandledRejection', (reason) => {
    logger.error(`[${context}] Unhandled promise rejection`, reason);
  });

  process.on('uncaughtException', (err) => {
    logger.error(`[${context}] Uncaught exception — exiting for a clean restart`, err);
    // Give the log a tick to flush, then exit non-zero so the supervisor restarts us.
    setTimeout(() => process.exit(1), 100).unref();
  });
}
