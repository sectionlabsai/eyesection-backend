import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../middleware/error';
import { getRedis } from '../config/redis';

const ACCESS_TTL = '15m';
const REFRESH_TTL = '30d';
const REVOKE_TTL_SEC = 30 * 24 * 60 * 60; // matches the refresh-token lifetime

// Pin the signing/verification algorithm. Without an explicit allowlist,
// jwt.verify accepts any algorithm the token's header claims — the classic
// alg-confusion foothold. We sign HS256 and verify HS256 only.
const JWT_ALG = 'HS256' as const;

export interface AccessPayload {
  sub: string; // user id
  type: 'access';
}
export interface RefreshPayload {
  sub: string;
  type: 'refresh';
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, type: 'access' }, env.JWT_SECRET, {
    expiresIn: ACCESS_TTL,
    algorithm: JWT_ALG,
  });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, type: 'refresh' }, env.JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TTL,
    algorithm: JWT_ALG,
  });
}

export function issueTokens(userId: string): { accessToken: string; refreshToken: string } {
  return {
    accessToken: signAccessToken(userId),
    refreshToken: signRefreshToken(userId),
  };
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: [JWT_ALG] }) as AccessPayload;
    if (decoded.type !== 'access') throw new Error('wrong token type');
    return decoded;
  } catch {
    throw new AppError(401, 'Invalid or expired token', 'INVALID_TOKEN');
  }
}

/**
 * Refresh-token revocation. Access tokens are short-lived (15m) and stateless;
 * to invalidate a session immediately (e.g. GDPR account deletion) we record
 * the user in a Redis blocklist that the refresh flow consults.
 */
function revokeKey(userId: string): string {
  return `auth:revoked:${userId}`;
}

export async function revokeUserTokens(userId: string): Promise<void> {
  await getRedis().set(revokeKey(userId), Date.now().toString(), 'EX', REVOKE_TTL_SEC);
}

export async function isUserRevoked(userId: string): Promise<boolean> {
  return (await getRedis().exists(revokeKey(userId))) === 1;
}

export function verifyRefreshToken(token: string): RefreshPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: [JWT_ALG] }) as RefreshPayload;
    if (decoded.type !== 'refresh') throw new Error('wrong token type');
    return decoded;
  } catch {
    throw new AppError(401, 'Invalid or expired refresh token', 'INVALID_REFRESH_TOKEN');
  }
}
