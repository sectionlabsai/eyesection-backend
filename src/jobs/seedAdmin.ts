/**
 * Seeds the first superadmin from env vars (EB-12). Idempotent — if an admin
 * with SEED_ADMIN_EMAIL already exists it is left untouched (password not
 * reset). Run with: `npm run seed:admin`.
 *
 * Required env: SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD.
 */
import bcrypt from 'bcrypt';
import { connectDB, disconnectDB } from '../config/db';
import { AdminUser } from '../models/AdminUser';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const BCRYPT_ROUNDS = 12;

async function seedAdmin(): Promise<void> {
  if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) {
    logger.error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set to seed an admin');
    process.exit(1);
  }

  await connectDB();
  try {
    const email = env.SEED_ADMIN_EMAIL.toLowerCase();
    const existing = await AdminUser.findOne({ email });
    if (existing) {
      logger.info(`Admin ${email} already exists — skipping`);
      return;
    }
    const passwordHash = await bcrypt.hash(env.SEED_ADMIN_PASSWORD, BCRYPT_ROUNDS);
    await AdminUser.create({ email, passwordHash, role: 'superadmin' });
    logger.info(`Superadmin ${email} created`);
  } finally {
    await disconnectDB();
  }
}

seedAdmin().catch((err) => {
  logger.error('Admin seed failed', err);
  process.exit(1);
});
