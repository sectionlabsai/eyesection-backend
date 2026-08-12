import { Types } from 'mongoose';
import {
  BreakPlan,
  IBreakPlan,
  ComfortEntry,
  Exercise,
  ExerciseSession,
  EyeScan,
  User,
} from '../models';
import { IReminder, ReminderType, BreakTemplate } from '../models/BreakPlan';
import { AppError } from '../middleware/error';
import { userIsPremium } from './entitlement.service';
import { invalidateChatContext } from './chatCache';
import { localDayKey, subDaysKey } from '../utils/day';

const DEFAULT_TZ = 'UTC';

export interface ActiveHours {
  start: string;
  end: string;
}

/**
 * Per-template tuning. Every plan gets the same four reminder TYPES (20-20-20,
 * blink, hydrate, evening wind-down) — templates only shift the active hours
 * and a few intervals to suit each lifestyle. All copy is screen-fatigue /
 * relaxation framing; nothing here claims to improve eyesight.
 */
const TEMPLATE_DEFAULTS: Record<
  BreakTemplate,
  { activeHours: ActiveHours; overrides?: Partial<Record<ReminderType, Partial<IReminder>>> }
> = {
  screen_worker: { activeHours: { start: '09:00', end: '18:00' } },
  night_phone: {
    activeHours: { start: '18:00', end: '23:00' },
    overrides: { blink: { intervalMin: 15 } },
  },
  gamer: {
    activeHours: { start: '13:00', end: '23:30' },
    overrides: { '2020': { intervalMin: 30 }, hydrate: { intervalMin: 45 } },
  },
  student: { activeHours: { start: '08:00', end: '22:00' } },
  driver: {
    activeHours: { start: '06:00', end: '19:00' },
    // Eyes stay on the road — no blink nudge; longer rest-break rhythm.
    overrides: {
      '2020': { intervalMin: 90 },
      blink: { enabled: false },
      hydrate: { intervalMin: 90 },
    },
  },
};

const TEMPLATES = Object.keys(TEMPLATE_DEFAULTS) as BreakTemplate[];

/** The four base reminders every plan starts from. */
function baseReminders(activeHours: ActiveHours): IReminder[] {
  return [
    { type: '2020', intervalMin: 20, enabled: true },
    { type: 'blink', intervalMin: 20, enabled: true },
    { type: 'hydrate', intervalMin: 60, enabled: true },
    { type: 'winddown', atTime: activeHours.end, enabled: true },
  ];
}

function applyOverrides(
  reminders: IReminder[],
  overrides?: Partial<Record<ReminderType, Partial<IReminder>>>,
): IReminder[] {
  if (!overrides) return reminders;
  return reminders.map((r) =>
    overrides[r.type] ? { ...r, ...overrides[r.type] } : r,
  );
}

async function userTimezone(userId: string): Promise<string> {
  const user = await User.findById(userId).select('notificationPrefs.timezone');
  return user?.notificationPrefs?.timezone || DEFAULT_TZ;
}

export interface GeneratePlanInput {
  userId: string;
  template?: string;
  activeHours?: ActiveHours;
  // Custom answers when no template is chosen — all optional tweaks.
  custom?: {
    breakIntervalMin?: number;
    blinkReminder?: boolean;
    hydrationReminder?: boolean;
    windDown?: boolean;
  };
}

/**
 * Generate (or replace) the user's break plan. One active plan per user, so
 * generating again overwrites the previous one.
 */
export async function generatePlan(input: GeneratePlanInput): Promise<IBreakPlan> {
  const templateKey =
    input.template && TEMPLATES.includes(input.template as BreakTemplate)
      ? (input.template as BreakTemplate)
      : 'custom';

  const preset =
    templateKey === 'custom' ? undefined : TEMPLATE_DEFAULTS[templateKey as BreakTemplate];

  const activeHours: ActiveHours =
    input.activeHours || preset?.activeHours || { start: '09:00', end: '22:00' };

  let reminders = baseReminders(activeHours);
  reminders = applyOverrides(reminders, preset?.overrides);

  // Custom answers layer on top of the base plan.
  if (templateKey === 'custom' && input.custom) {
    const c = input.custom;
    reminders = reminders.map((r) => {
      if (r.type === '2020' && typeof c.breakIntervalMin === 'number') {
        return { ...r, intervalMin: c.breakIntervalMin };
      }
      if (r.type === 'blink' && typeof c.blinkReminder === 'boolean') {
        return { ...r, enabled: c.blinkReminder };
      }
      if (r.type === 'hydrate' && typeof c.hydrationReminder === 'boolean') {
        return { ...r, enabled: c.hydrationReminder };
      }
      if (r.type === 'winddown' && typeof c.windDown === 'boolean') {
        return { ...r, enabled: c.windDown };
      }
      return r;
    });
  }

  const plan = await BreakPlan.findOneAndUpdate(
    { userId: new Types.ObjectId(input.userId) },
    {
      $set: {
        template: templateKey,
        reminders,
        activeHours,
        active: true,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  void invalidateChatContext(input.userId);
  return plan;
}

export async function getPlan(userId: string): Promise<IBreakPlan | null> {
  return BreakPlan.findOne({ userId: new Types.ObjectId(userId) });
}

export interface UpdatePlanInput {
  activeHours?: ActiveHours;
  active?: boolean;
  // Merge-by-type patches for individual reminders.
  reminders?: Array<{
    type: ReminderType;
    enabled?: boolean;
    intervalMin?: number;
    atTime?: string;
  }>;
}

export async function updatePlan(
  userId: string,
  patch: UpdatePlanInput,
): Promise<IBreakPlan> {
  const plan = await BreakPlan.findOne({ userId: new Types.ObjectId(userId) });
  if (!plan) throw new AppError(404, 'No break plan yet', 'PLAN_NOT_FOUND');

  if (patch.activeHours) {
    plan.activeHours = patch.activeHours;
    // Keep the wind-down aligned with the new end-of-day unless overridden.
    const winddown = plan.reminders.find((r) => r.type === 'winddown');
    if (winddown && !patch.reminders?.some((p) => p.type === 'winddown' && p.atTime)) {
      winddown.atTime = patch.activeHours.end;
    }
  }
  if (typeof patch.active === 'boolean') plan.active = patch.active;

  if (patch.reminders) {
    for (const p of patch.reminders) {
      const existing = plan.reminders.find((r) => r.type === p.type);
      if (!existing) continue; // only known reminder types are patchable
      if (typeof p.enabled === 'boolean') existing.enabled = p.enabled;
      if (typeof p.intervalMin === 'number') existing.intervalMin = p.intervalMin;
      if (typeof p.atTime === 'string') existing.atTime = p.atTime;
    }
    plan.markModified('reminders');
  }

  await plan.save();
  void invalidateChatContext(userId);
  return plan;
}

/**
 * Serialize a plan into the flat schedule the CLIENT uses to register local
 * notifications. Only enabled reminders are returned; the client schedules
 * them within activeHours.
 */
export function toLocalReminders(plan: IBreakPlan): {
  activeHours: ActiveHours;
  active: boolean;
  reminders: Array<{
    type: ReminderType;
    intervalMin?: number;
    atTime?: string;
    enabled: boolean;
  }>;
} {
  return {
    activeHours: {
      start: plan.activeHours.start,
      end: plan.activeHours.end,
    },
    active: plan.active,
    reminders: plan.reminders
      .filter((r) => r.enabled)
      .map((r) => ({
        type: r.type,
        ...(typeof r.intervalMin === 'number' ? { intervalMin: r.intervalMin } : {}),
        ...(r.atTime ? { atTime: r.atTime } : {}),
        enabled: r.enabled,
      })),
  };
}

/**
 * Log a completed relaxation/break exercise session.
 *
 * Hardened (EB-08): only real catalog exercises can be logged, and premium
 * routines are gated server-side. The client also gates the player, but
 * entitlement is never trusted from the client.
 */
export async function logExerciseSession(
  userId: string,
  exerciseId: string,
  durationSec: number,
): Promise<{ id: string; completedAt: Date }> {
  const exercise = await Exercise.findOne({ exerciseId }).select('premium');
  if (!exercise) {
    throw new AppError(404, "We couldn't find that exercise", 'UNKNOWN_EXERCISE');
  }
  if (exercise.premium && !(await userIsPremium(userId))) {
    throw new AppError(402, 'This is a premium exercise', 'PREMIUM_REQUIRED');
  }

  const session = await ExerciseSession.create({
    userId: new Types.ObjectId(userId),
    exerciseId,
    durationSec,
    completedAt: new Date(),
  });
  // Activity/streak just changed — refresh the chat context. Fire-and-forget.
  void invalidateChatContext(userId);
  return { id: session._id.toString(), completedAt: session.completedAt };
}

/**
 * Current daily-engagement streak: consecutive local days ending today (or, if
 * nothing yet today, ending yesterday) on which the user did ANY tracked
 * activity — a scan, a comfort entry, or an exercise session.
 */
export async function getStreak(userId: string): Promise<{
  streak: number;
  lastActiveDay: string | null;
}> {
  const tz = await userTimezone(userId);
  const uid = new Types.ObjectId(userId);

  // Only the last ~90 days of activity matter for a current streak.
  const since = new Date(Date.now() - 92 * 24 * 60 * 60 * 1000);

  const [scans, comforts, sessions] = await Promise.all([
    EyeScan.find({ userId: uid, createdAt: { $gte: since } }).select('createdAt'),
    ComfortEntry.find({ userId: uid, date: { $gte: since } }).select('date'),
    ExerciseSession.find({ userId: uid, completedAt: { $gte: since } }).select(
      'completedAt',
    ),
  ]);

  const activeDays = new Set<string>();
  for (const s of scans) activeDays.add(localDayKey(s.createdAt, tz));
  for (const c of comforts) activeDays.add(localDayKey(c.date, tz));
  for (const s of sessions) activeDays.add(localDayKey(s.completedAt, tz));

  const todayKey = localDayKey(new Date(), tz);
  const yesterdayKey = subDaysKey(todayKey, 1);

  // A streak is only "current" if there was activity today or yesterday.
  let cursor: string;
  if (activeDays.has(todayKey)) cursor = todayKey;
  else if (activeDays.has(yesterdayKey)) cursor = yesterdayKey;
  else return { streak: 0, lastActiveDay: activeDays.size ? maxKey(activeDays) : null };

  let streak = 0;
  while (activeDays.has(cursor)) {
    streak += 1;
    cursor = subDaysKey(cursor, 1);
  }

  return { streak, lastActiveDay: maxKey(activeDays) };
}

function maxKey(keys: Set<string>): string {
  let max = '';
  for (const k of keys) if (k > max) max = k;
  return max;
}
