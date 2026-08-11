import fs from 'fs';
import admin from 'firebase-admin';
import { env } from './env';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';

/**
 * Lazy Firebase Admin init. FIREBASE_SERVICE_ACCOUNT may be either the full
 * service-account JSON as a single-line string, or a path to the JSON file.
 * Not configured yet? Social login errors only when actually called.
 */
let app: admin.app.App | null = null;

function loadServiceAccount(): admin.ServiceAccount {
  const raw = env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    throw new AppError(503, 'Social login is not available right now', 'AUTH_UNAVAILABLE');
  }
  const isInlineJson = raw.trim().startsWith('{');
  if (!isInlineJson && env.NODE_ENV === 'production') {
    // A service-account key file on disk in production is a footgun (leaks via
    // image/backup). Prefer injecting the JSON from a secret manager.
    logger.warn(
      'FIREBASE_SERVICE_ACCOUNT is a file path in production — prefer injecting ' +
        'the service-account JSON from a secret manager instead of a file on disk.',
    );
  }
  try {
    const json = isInlineJson ? JSON.parse(raw) : JSON.parse(fs.readFileSync(raw, 'utf8'));
    return json as admin.ServiceAccount;
  } catch (err) {
    logger.error('Failed to load FIREBASE_SERVICE_ACCOUNT', err);
    throw new AppError(503, 'Social login is not available right now', 'AUTH_UNAVAILABLE');
  }
}

function getApp(): admin.app.App {
  if (app) return app;
  app = admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  return app;
}

/** Firebase Cloud Messaging client (EB-11 push). Errors only when actually used. */
export function getMessaging(): admin.messaging.Messaging {
  return admin.messaging(getApp());
}

export interface FirebaseIdentity {
  firebaseUid: string;
  email?: string;
  displayName?: string;
  photoURL?: string;
}

/** Verify a Firebase ID token and return the normalized identity. */
export async function verifyFirebaseIdToken(idToken: string): Promise<FirebaseIdentity> {
  const decoded = await getApp().auth().verifyIdToken(idToken);
  return {
    firebaseUid: decoded.uid,
    email: decoded.email,
    displayName: decoded.name,
    photoURL: decoded.picture,
  };
}

/** Firebase Admin Auth client. Errors only when actually used (lazy init). */
export function getAuth(): admin.auth.Auth {
  return getApp().auth();
}

/**
 * Guarantee a Firebase Auth account exists for `email` so a password-reset email
 * can be sent to it. Email/password identity now lives in Firebase, but legacy
 * users created before that migration exist only as a bcrypt hash in Mongo with
 * no Firebase account — `sendPasswordResetEmail` would fail for them. This
 * lazily provisions the missing Firebase user (importing the existing bcrypt
 * hash when available, so an abandoned reset still leaves the old password
 * working) and returns the Firebase uid to persist on the Mongo document.
 */
export async function ensureFirebaseUserForReset(
  email: string,
  opts: { uid: string; bcryptHash?: string },
): Promise<string> {
  const auth = getAuth();

  const existingUid = await findFirebaseUidByEmail(auth, email);
  if (existingUid) return existingUid;

  // Legacy bcrypt-only user: import them preserving their password when we have
  // the hash, otherwise create a passwordless account they'll set via the reset.
  if (opts.bcryptHash) {
    const result = await auth.importUsers(
      [{ uid: opts.uid, email, passwordHash: Buffer.from(opts.bcryptHash) }],
      { hash: { algorithm: 'BCRYPT' } },
    );
    if (result.failureCount === 0) return opts.uid;
    logger.warn(
      'ensureFirebaseUserForReset: bcrypt import failed, creating passwordless user',
      result.errors,
    );
  }
  return createResettableFirebaseUser(auth, email, opts.uid);
}

async function findFirebaseUidByEmail(
  auth: admin.auth.Auth,
  email: string,
): Promise<string | null> {
  try {
    const user = await auth.getUserByEmail(email);
    return user.uid;
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/user-not-found') return null;
    throw err;
  }
}

async function createResettableFirebaseUser(
  auth: admin.auth.Auth,
  email: string,
  uid: string,
): Promise<string> {
  try {
    const record = await auth.createUser({ uid, email });
    return record.uid;
  } catch (err) {
    // Raced with another create, or the uid/email is already taken — resolve to
    // whatever account now owns the email.
    const code = (err as { code?: string }).code;
    if (code === 'auth/email-already-exists' || code === 'auth/uid-already-exists') {
      const existingUid = await findFirebaseUidByEmail(auth, email);
      if (existingUid) return existingUid;
    }
    throw err;
  }
}
