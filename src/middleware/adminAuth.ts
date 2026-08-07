import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from './error';
import { AdminRole } from '../models/AdminUser';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminId?: string;
      adminRole?: AdminRole;
    }
  }
}

const ADMIN_TTL = '12h';

interface AdminPayload {
  sub: string;
  role: AdminRole;
  type: 'admin';
}

/** Admin tokens are signed with a SEPARATE secret from user tokens (EB-12). */
export function signAdminToken(adminId: string, role: AdminRole): string {
  return jwt.sign({ sub: adminId, role, type: 'admin' }, env.ADMIN_JWT_SECRET, {
    expiresIn: ADMIN_TTL,
  });
}

function verifyAdminToken(token: string): AdminPayload {
  try {
    const decoded = jwt.verify(token, env.ADMIN_JWT_SECRET) as AdminPayload;
    if (decoded.type !== 'admin') throw new Error('wrong token type');
    return decoded;
  } catch {
    throw new AppError(401, 'Invalid or expired admin token', 'ADMIN_UNAUTHENTICATED');
  }
}

function extractBearer(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

/** Require a valid admin token; attaches req.adminId + req.adminRole. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const token = extractBearer(req);
  if (!token) throw new AppError(401, 'Admin authentication required', 'ADMIN_UNAUTHENTICATED');
  const payload = verifyAdminToken(token);
  req.adminId = payload.sub;
  req.adminRole = payload.role;
  next();
}

/** Require the superadmin role (destructive / privileged operations). */
export function requireSuperadmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.adminRole !== 'superadmin') {
    throw new AppError(403, 'Superadmin access required', 'ADMIN_FORBIDDEN');
  }
  next();
}
