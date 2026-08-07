import { Types } from 'mongoose';
import { ComfortEntry, IComfortEntry, User } from '../models';
import { AppError } from '../middleware/error';
import { localDayStart } from '../utils/day';
import { computeComfort, ComfortInputs } from './scoring/comfort.service';
import { invalidateChatContext } from './chatCache';

const DEFAULT_TZ = 'UTC';

/** The user's stored IANA timezone (from notificationPrefs) or UTC. */
async function userTimezone(userId: string): Promise<string> {
  const user = await User.findById(userId).select('notificationPrefs.timezone');
  return user?.notificationPrefs?.timezone || DEFAULT_TZ;
}

export interface ComfortSubmission extends ComfortInputs {
  userId: string;
}

/**
 * Submit today's answers. One entry per user per local day — re-submitting the
 * same day updates (upserts) that day's entry rather than creating a new one.
 */
export async function submitComfort(input: ComfortSubmission): Promise<{
  comfortScore: number;
  band: string;
  message: string;
}> {
  const { userId, ...inputs } = input;
  const { comfortScore, band, message } = computeComfort(inputs);

  const tz = await userTimezone(userId);
  const date = localDayStart(new Date(), tz);

  await ComfortEntry.findOneAndUpdate(
    { userId: new Types.ObjectId(userId), date },
    { $set: { inputs, comfortScore, band } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // Today's comfort log feeds the chat context — refresh it. Fire-and-forget.
  void invalidateChatContext(userId);

  return { comfortScore, band, message };
}

function toEntryView(entry: IComfortEntry): Record<string, unknown> {
  return {
    date: entry.date,
    comfortScore: entry.comfortScore,
    band: entry.band,
    inputs: entry.inputs,
  };
}

/** Recent entries (newest first) for trend charts. */
export async function getHistory(
  userId: string,
  days: number,
): Promise<Record<string, unknown>[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const entries = await ComfortEntry.find({
    userId: new Types.ObjectId(userId),
    date: { $gte: since },
  }).sort({ date: -1 });
  return entries.map(toEntryView);
}

/** Today's entry, or null if the user hasn't logged yet today. */
export async function getToday(
  userId: string,
): Promise<Record<string, unknown> | null> {
  const tz = await userTimezone(userId);
  const date = localDayStart(new Date(), tz);
  const entry = await ComfortEntry.findOne({
    userId: new Types.ObjectId(userId),
    date,
  });
  return entry ? toEntryView(entry) : null;
}

/* ------------------------------------------------------------------ *
 * Screen Comfort Checks — ergonomic / behavioural tips ONLY.
 * These are NOT vision tests and NEVER a diagnosis. Each returns a
 * friendly band + tip based on a self-reported value.
 * ------------------------------------------------------------------ */

export interface CheckResult {
  band: string;
  tip: string;
}

/** Client-measured face-to-screen distance (cm) → a comfortable-viewing tip. */
export function screenDistanceCheck(distanceCm: number): CheckResult {
  if (distanceCm < 40) {
    return {
      band: 'Close',
      tip: 'Your screen looks quite close. Easing it back to about an arm’s length (50–70 cm) can help your eyes relax.',
    };
  }
  if (distanceCm <= 70) {
    return {
      band: 'Comfortable',
      tip: 'Nice — that’s a relaxed viewing distance. Keeping the screen around an arm’s length away is easy on the eyes.',
    };
  }
  return {
    band: 'Far',
    tip: 'That’s a comfortably far distance. Just make sure text stays easy to read without leaning in or squinting.',
  };
}

/** Self-rated screen brightness comfort (0-3) → a friendly tip. */
export function brightnessCheck(rating: number): CheckResult {
  if (rating <= 1) {
    return {
      band: 'Harsh',
      tip: 'Your screen may feel a little harsh. Try matching its brightness to the room and warming the colour temperature in the evening.',
    };
  }
  if (rating === 2) {
    return {
      band: 'Okay',
      tip: 'Brightness feels okay. Softer, warmer light after sunset can make longer sessions more comfortable.',
    };
  }
  return {
    band: 'Comfortable',
    tip: 'Your brightness feels comfortable — a nice match for your surroundings. Keep it up.',
  };
}

/** Self-rated break habit (0-3) → an encouraging tip. */
export function breakHabitCheck(rating: number): CheckResult {
  if (rating <= 1) {
    return {
      band: 'Needs Breaks',
      tip: 'Breaks are easy to forget. A gentle 20-20-20 nudge every 20 minutes can give your eyes regular little rests.',
    };
  }
  if (rating === 2) {
    return {
      band: 'Building',
      tip: 'You’re building a good rhythm. Try to make those short breaks a steady habit through the day.',
    };
  }
  return {
    band: 'Great',
    tip: 'Lovely — you’re taking regular breaks. Your eyes appreciate the steady rest.',
  };
}

/** Guard used by the controller for a missing/invalid user context. */
export function requireUser(userId?: string): string {
  if (!userId) throw new AppError(401, 'Authentication required', 'UNAUTHENTICATED');
  return userId;
}
