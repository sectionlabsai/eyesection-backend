import { Request, Response } from 'express';
import { z } from 'zod';
import * as accountService from '../services/account.service';
import { requireUser } from '../services/comfort.service';

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm (24h)');

// Whitelisted profile fields. `.strict()` rejects anything unexpected so the
// client can never write to sensitive fields (subscription, status, …).
const profileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    concerns: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    goal: z.string().trim().max(120).optional(),
    careProducts: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    baselineComfort: z.string().trim().max(60).optional(),
    screenProfile: z
      .object({
        dailyScreenHours: z.number().min(0).max(24).optional(),
        nightPhoneUse: z.boolean().optional(),
        wearsGlasses: z.boolean().optional(),
        role: z.string().trim().max(60).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const patch = profileSchema.parse(req.body);
  const user = await accountService.updateProfile(userId, patch);
  res.status(200).json({ user });
}

const notificationsSchema = z
  .object({
    breaks: z.boolean().optional(),
    comfort: z.boolean().optional(),
    results: z.boolean().optional(),
    marketing: z.boolean().optional(),
    quietStart: hhmm.optional(),
    quietEnd: hhmm.optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export async function updateNotifications(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const patch = notificationsSchema.parse(req.body);
  const notificationPrefs = await accountService.updateNotificationPrefs(userId, patch);
  res.status(200).json({ notificationPrefs });
}
