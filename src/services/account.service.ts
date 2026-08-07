import { User, IUser } from '../models';
import { AppError } from '../middleware/error';
import { sanitizeUser } from './auth.service';

/**
 * Profile / quiz persistence (EB-13). Callers pass an already-validated,
 * whitelisted patch; we translate it into a dotted `$set` so nested objects
 * (screenProfile, notificationPrefs) are merged rather than replaced.
 */
export interface ProfilePatch {
  displayName?: string;
  concerns?: string[];
  goal?: string;
  careProducts?: string[];
  baselineComfort?: string;
  screenProfile?: {
    dailyScreenHours?: number;
    nightPhoneUse?: boolean;
    wearsGlasses?: boolean;
    role?: string;
  };
}

const PROFILE_FIELDS = [
  'displayName',
  'concerns',
  'goal',
  'careProducts',
  'baselineComfort',
] as const;

export async function updateProfile(
  userId: string,
  patch: ProfilePatch,
): Promise<Record<string, unknown>> {
  const $set: Record<string, unknown> = {};
  for (const field of PROFILE_FIELDS) {
    if (patch[field] !== undefined) $set[field] = patch[field];
  }
  if (patch.screenProfile) {
    for (const [k, v] of Object.entries(patch.screenProfile)) {
      if (v !== undefined) $set[`screenProfile.${k}`] = v;
    }
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set },
    { new: true, runValidators: true },
  );
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  return sanitizeUser(user);
}

export interface NotificationPrefsPatch {
  breaks?: boolean;
  comfort?: boolean;
  results?: boolean;
  marketing?: boolean;
  quietStart?: string;
  quietEnd?: string;
  timezone?: string;
}

export async function updateNotificationPrefs(
  userId: string,
  patch: NotificationPrefsPatch,
): Promise<IUser['notificationPrefs']> {
  const $set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) $set[`notificationPrefs.${k}`] = v;
  }

  const user = await User.findByIdAndUpdate(
    userId,
    { $set },
    { new: true, runValidators: true },
  ).select('notificationPrefs');
  if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND');
  return user.notificationPrefs;
}
