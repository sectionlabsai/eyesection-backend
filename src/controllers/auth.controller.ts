import { Request, Response } from 'express';
import { z } from 'zod';
import * as authService from '../services/auth.service';
import { AppError } from '../middleware/error';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().trim().min(1).max(64).optional(), // IANA tz, stored at signup
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const socialSchema = z.object({
  idToken: z.string().min(1),
  // 'email' = Firebase email/password account; client creates it in Firebase Auth.
  provider: z.enum(['google', 'apple', 'email']),
});

const upgradeSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('email'),
    email: z.string().email(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    displayName: z.string().trim().min(1).max(80).optional(),
  }),
  z.object({
    method: z.literal('social'),
    idToken: z.string().min(1),
    provider: z.enum(['google', 'apple', 'email']),
  }),
]);

const refreshSchema = z.object({ refreshToken: z.string().min(1) });
const forgotSchema = z.object({ email: z.string().email() });
const resetSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export async function register(req: Request, res: Response): Promise<void> {
  const { email, password, displayName, timezone } = registerSchema.parse(req.body);
  const result = await authService.register(email, password, displayName, timezone);
  res.status(201).json(result);
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = loginSchema.parse(req.body);
  const result = await authService.login(email, password);
  res.status(200).json(result);
}

export async function anonymous(_req: Request, res: Response): Promise<void> {
  const result = await authService.createAnonymous();
  res.status(201).json(result);
}

export async function upgrade(req: Request, res: Response): Promise<void> {
  if (!req.userId) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
  const input = upgradeSchema.parse(req.body);
  const result = await authService.upgradeAccount(req.userId, input);
  res.status(200).json(result);
}

export async function social(req: Request, res: Response): Promise<void> {
  const { idToken, provider } = socialSchema.parse(req.body);
  const result = await authService.socialLogin(idToken, provider);
  res.status(200).json(result);
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = refreshSchema.parse(req.body);
  const result = await authService.refresh(refreshToken);
  res.status(200).json(result);
}

export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const { email } = forgotSchema.parse(req.body);
  await authService.forgotPassword(email);
  // Always success — never reveals whether the email exists.
  res.status(200).json({ message: 'If that email exists, a reset link has been sent.' });
}

export async function resetPassword(req: Request, res: Response): Promise<void> {
  const { token, password } = resetSchema.parse(req.body);
  await authService.resetPassword(token, password);
  res.status(200).json({ message: 'Your password has been updated.' });
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.userId) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
  const user = await authService.getMe(req.userId);
  res.status(200).json({ user });
}
