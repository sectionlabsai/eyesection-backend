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
  try {
    const json = raw.trim().startsWith('{')
      ? JSON.parse(raw)
      : JSON.parse(fs.readFileSync(raw, 'utf8'));
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
