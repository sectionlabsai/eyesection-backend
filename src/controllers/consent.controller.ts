import { Request, Response } from 'express';
import { z } from 'zod';
import { User } from '../models';
import { AppError } from '../middleware/error';
import { requireUser } from '../services/comfort.service';

function consentView(consent: {
  termsAt?: Date;
  privacyAt?: Date;
  marketing: boolean;
}): Record<string, unknown> {
  return {
    termsAccepted: !!consent.termsAt,
    privacyAccepted: !!consent.privacyAt,
    termsAt: consent.termsAt ?? null,
    privacyAt: consent.privacyAt ?? null,
    marketing: consent.marketing,
  };
}

export async function get(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const user = await User.findById(userId).select('consent');
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  res.status(200).json(consentView(user.consent));
}

const setSchema = z.object({
  terms: z.boolean().optional(),
  privacy: z.boolean().optional(),
  marketing: z.boolean().optional(),
});

export async function set(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const { terms, privacy, marketing } = setSchema.parse(req.body);

  const user = await User.findById(userId).select('consent');
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');

  // Accepting stamps the time; we never silently un-accept terms/privacy.
  if (terms && !user.consent.termsAt) user.consent.termsAt = new Date();
  if (privacy && !user.consent.privacyAt) user.consent.privacyAt = new Date();
  if (typeof marketing === 'boolean') user.consent.marketing = marketing;

  await user.save();
  res.status(200).json(consentView(user.consent));
}
