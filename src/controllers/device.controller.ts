import { Request, Response } from 'express';
import { z } from 'zod';
import { User } from '../models';
import { requireUser } from '../services/comfort.service';

const tokenSchema = z.object({ token: z.string().min(1).max(4096) });

/** Register an FCM token for push (idempotent via $addToSet). */
export async function register(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const { token } = tokenSchema.parse(req.body);
  await User.updateOne({ _id: userId }, { $addToSet: { fcmTokens: token } });
  res.status(200).json({ registered: true });
}

export async function unregister(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const { token } = tokenSchema.parse(req.body);
  await User.updateOne({ _id: userId }, { $pull: { fcmTokens: token } });
  res.status(200).json({ unregistered: true });
}
