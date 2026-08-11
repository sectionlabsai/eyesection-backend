import bcrypt from 'bcrypt';
import { User, IUser } from '../models/User';
import { AppError } from '../middleware/error';
import { issueTokens, verifyRefreshToken, isUserRevoked } from './token.service';
import { verifyFirebaseIdToken, ensureFirebaseUserForReset } from '../config/firebase';

const BCRYPT_ROUNDS = 12;

// A valid cost-12 bcrypt hash of a throwaway string. When login is attempted for
// an unknown email we still run a compare against this so response timing does
// not reveal whether the email exists (user-enumeration oracle).
const DUMMY_BCRYPT_HASH = '$2b$12$MX16Gjnp1/abrhQREO6sau87hY8XXzG5V6p/MGw8IfFnr9IvSb5wi';

/** Strip sensitive fields before returning a user to the client. */
export function sanitizeUser(user: IUser): Record<string, unknown> {
  const obj = user.toObject ? user.toObject() : user;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { passwordHash, __v, ...safe } = obj as Record<string, unknown>;
  return safe;
}

interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: Record<string, unknown>;
}

export async function register(
  email: string,
  password: string,
  displayName?: string,
  timezone?: string,
): Promise<AuthResult> {
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new AppError(409, 'That email is already registered', 'EMAIL_TAKEN');

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.create({
    email: email.toLowerCase(),
    passwordHash,
    authProvider: 'email',
    displayName,
    // Store the user's IANA timezone at signup so quiet hours / day buckets
    // (EB-07, EB-08, EB-11) line up with their local clock.
    ...(timezone ? { notificationPrefs: { timezone } } : {}),
  });
  // rcAppUserId = the user's _id, so RevenueCat maps back cleanly (EB-10).
  user.subscription.rcAppUserId = user._id.toString();
  await user.save();

  const tokens = issueTokens(user._id.toString());
  return { ...tokens, user: sanitizeUser(user) };
}

/**
 * Anonymous-first session (EB-13). Mints a real User with no email/password so
 * quiz answers, scans and consent can attach to a stable _id before the user
 * signs up. Upgraded later via upgradeAccount, preserving that _id and all data.
 */
export async function createAnonymous(): Promise<AuthResult> {
  const user = await User.create({
    authProvider: 'anonymous',
    isAnonymous: true,
  });
  user.subscription.rcAppUserId = user._id.toString();
  await user.save();

  const tokens = issueTokens(user._id.toString());
  return { ...tokens, user: sanitizeUser(user) };
}

export type UpgradeInput =
  | { method: 'email'; email: string; password: string; displayName?: string }
  | { method: 'social'; idToken: string; provider: 'google' | 'apple' | 'email' };

/**
 * Attach real credentials (email/password or a Firebase social identity) to the
 * CURRENT anonymous user, preserving _id and every related record. Guards against
 * upgrading an already-registered account and against email/identity collisions.
 */
export async function upgradeAccount(
  userId: string,
  input: UpgradeInput,
): Promise<AuthResult> {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  if (!user.isAnonymous) {
    throw new AppError(409, 'This account is already registered', 'ALREADY_REGISTERED');
  }

  if (input.method === 'email') {
    const email = input.email.toLowerCase();
    if (await User.findOne({ email })) {
      throw new AppError(409, 'That email is already registered', 'EMAIL_TAKEN');
    }
    user.email = email;
    user.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    user.authProvider = 'email';
    if (input.displayName) user.displayName = input.displayName;
  } else {
    const identity = await verifyFirebaseIdToken(input.idToken);
    if (!identity.email) {
      throw new AppError(400, 'Could not complete sign in', 'SOCIAL_NO_EMAIL');
    }
    const email = identity.email.toLowerCase();
    const clash = await User.findOne({
      $or: [{ firebaseUid: identity.firebaseUid }, { email }],
    });
    if (clash && clash._id.toString() !== user._id.toString()) {
      throw new AppError(409, 'That account is already linked to another user', 'EMAIL_TAKEN');
    }
    user.email = email;
    user.firebaseUid = identity.firebaseUid;
    user.authProvider = input.provider;
    if (identity.displayName && !user.displayName) user.displayName = identity.displayName;
    if (identity.photoURL && !user.photoURL) user.photoURL = identity.photoURL;
  }

  user.isAnonymous = false;
  if (!user.subscription.rcAppUserId) {
    user.subscription.rcAppUserId = user._id.toString();
  }
  user.lastActiveAt = new Date();
  await user.save();

  // Same _id is preserved, so the existing tokens stay valid — but the client
  // expects the standard {accessToken, refreshToken, user} envelope on every
  // auth response, so issue a fresh pair here to match register/login/social.
  const tokens = issueTokens(user._id.toString());
  return { ...tokens, user: sanitizeUser(user) };
}

export async function login(email: string, password: string): Promise<AuthResult> {
  // Generic error regardless of which part fails — never reveal if the email exists.
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user || !user.passwordHash) {
    // Run a compare anyway so timing matches the found-user path (no enumeration).
    await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
    throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');

  await assertAccountActive(user);

  user.lastActiveAt = new Date();
  await user.save();

  const tokens = issueTokens(user._id.toString());
  return { ...tokens, user: sanitizeUser(user) };
}

/**
 * Enforce suspension / revocation at sign-in. Without this a suspended (or
 * admin-revoked) user could simply log in again for a fresh token pair — the
 * blocklist and status were previously only consulted in refresh(). Runs only
 * for an already-existing account (a just-created social user is never
 * suspended). Reveals suspension explicitly: the credentials are valid, so
 * there is no enumeration concern, and the user needs to know why.
 */
async function assertAccountActive(user: IUser): Promise<void> {
  if (user.status === 'suspended' || (await isUserRevoked(user._id.toString()))) {
    throw new AppError(403, 'This account has been suspended', 'ACCOUNT_SUSPENDED');
  }
}

export async function socialLogin(
  idToken: string,
  provider: 'google' | 'apple' | 'email',
): Promise<AuthResult> {
  const identity = await verifyFirebaseIdToken(idToken);

  let user =
    (await User.findOne({ firebaseUid: identity.firebaseUid })) ||
    (identity.email ? await User.findOne({ email: identity.email.toLowerCase() }) : null);

  if (!user) {
    if (!identity.email) {
      throw new AppError(400, 'Could not complete sign in', 'SOCIAL_NO_EMAIL');
    }
    user = await User.create({
      email: identity.email.toLowerCase(),
      authProvider: provider,
      firebaseUid: identity.firebaseUid,
      displayName: identity.displayName,
      photoURL: identity.photoURL,
    });
    user.subscription.rcAppUserId = user._id.toString();
  } else {
    // Existing account — enforce suspension/revocation before re-issuing tokens,
    // otherwise a suspended user could sign back in via Firebase for fresh tokens.
    await assertAccountActive(user);
    // Link the firebase uid / provider on first social sign-in for an existing account.
    user.firebaseUid = identity.firebaseUid;
    user.authProvider = provider;
    if (!user.subscription.rcAppUserId) {
      user.subscription.rcAppUserId = user._id.toString();
    }
  }
  user.lastActiveAt = new Date();
  await user.save();

  const tokens = issueTokens(user._id.toString());
  return { ...tokens, user: sanitizeUser(user) };
}

export async function refresh(refreshToken: string): Promise<{ accessToken: string }> {
  const payload = verifyRefreshToken(refreshToken);
  if (await isUserRevoked(payload.sub)) {
    throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }
  const user = await User.findById(payload.sub);
  if (!user || user.status === 'suspended') {
    throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }
  const { accessToken } = issueTokens(user._id.toString());
  return { accessToken };
}

/**
 * Prepare a Firebase password-reset for `email`, then let the client trigger the
 * actual send (Firebase owns email/password identity and email delivery now).
 *
 * The only server-side work is guaranteeing a Firebase Auth account exists:
 * legacy users created before the Firebase migration live only as a bcrypt hash
 * in Mongo, so `sendPasswordResetEmail` would have nothing to send to. We
 * provision the missing Firebase user (preserving their password via bcrypt
 * import) and record its uid for future sign-ins.
 *
 * Always resolves — never reveals whether the email exists (no enumeration).
 */
export async function forgotPassword(email: string): Promise<void> {
  const normalized = email.toLowerCase();
  const user = await User.findOne({ email: normalized }).select('+passwordHash');
  if (!user) return; // silent — do not leak existence

  // Already a Firebase-native account (social sign-in, or an email user who has
  // logged in since the migration): the client's reset email will reach it.
  if (user.firebaseUid) return;

  const firebaseUid = await ensureFirebaseUserForReset(normalized, {
    uid: user._id.toString(),
    bcryptHash: user.passwordHash,
  });
  user.firebaseUid = firebaseUid;
  await user.save();
}

export async function getMe(userId: string): Promise<Record<string, unknown>> {
  const user = await User.findById(userId);
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  return sanitizeUser(user);
}
