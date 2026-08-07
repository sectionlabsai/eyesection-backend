import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

/** Connect to MongoDB with bounded retries. Throws if all retries fail. */
export async function connectDB(): Promise<void> {
  mongoose.set('strictQuery', true);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await mongoose.connect(env.MONGODB_URI);
      logger.info('MongoDB connected');
      mongoose.connection.on('disconnected', () =>
        logger.warn('MongoDB disconnected'),
      );
      mongoose.connection.on('error', (err) =>
        logger.error('MongoDB connection error', err),
      );
      return;
    } catch (err) {
      logger.error(
        `MongoDB connection attempt ${attempt}/${MAX_RETRIES} failed`,
        err,
      );
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected (shutdown)');
}

/**
 * Reconcile every registered model's indexes with its schema. Notably this
 * makes the EB-13 schema change safe on existing databases: the User `email`
 * index moves from a plain unique index to a SPARSE unique one, so
 * anonymous-first users (no email) no longer collide on the null value.
 *
 * Best-effort — a sync failure is logged but never blocks startup. Models are
 * already registered by the time this runs (route imports pull them in), so
 * `mongoose.models` is fully populated.
 */
export async function syncIndexes(): Promise<void> {
  const models = Object.values(mongoose.models);
  const results = await Promise.allSettled(models.map((m) => m.syncIndexes()));
  for (const r of results) {
    if (r.status === 'rejected') logger.error('Index sync failed', r.reason);
  }
  logger.info(`Index sync complete (${models.length} models)`);
}

/**
 * Liveness/readiness probe for MongoDB. Sends an actual `ping` command (rather
 * than trusting the cached connection state, which can lag a network partition)
 * and bounds it so a stalled socket can't hang the health endpoint.
 */
export async function pingDB(timeoutMs = 2000): Promise<boolean> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) return false;
  try {
    await Promise.race([
      db.admin().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}
