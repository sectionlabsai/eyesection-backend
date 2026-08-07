/* Minimal structured logger. Swap for pino/winston later without changing call sites. */

type Level = 'info' | 'warn' | 'error' | 'debug';

function emit(level: Level, msg: string, meta?: unknown): void {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  // eslint-disable-next-line no-console
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (meta !== undefined) {
    fn(line, meta);
  } else {
    fn(line);
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) => emit('info', msg, meta),
  warn: (msg: string, meta?: unknown) => emit('warn', msg, meta),
  error: (msg: string, meta?: unknown) => emit('error', msg, meta),
  debug: (msg: string, meta?: unknown) => {
    if (process.env.NODE_ENV !== 'production') emit('debug', msg, meta);
  },
};
