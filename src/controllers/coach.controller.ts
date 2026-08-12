import { Request, Response } from 'express';
import { z } from 'zod';
import * as coachService from '../services/coach.service';
import { requireUser } from '../services/comfort.service';

const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm (24h)');
const endHhmm = z.union([hhmm, z.literal('24:00')]);

function minutes(hhmmValue: string): number {
  const [hour, minute] = hhmmValue.split(':').map(Number);
  return hour * 60 + minute;
}

export const activeHoursSchema = z
  .object({ start: hhmm, end: endHhmm })
  .refine((hours) => minutes(hours.start) < minutes(hours.end), {
    message: 'Active hours must end after they start',
    path: ['end'],
  });

const reminderType = z.enum(['2020', 'blink', 'hydrate', 'winddown']);

const generateSchema = z.object({
  template: z.enum(['screen_worker', 'night_phone', 'gamer', 'student', 'driver']).optional(),
  activeHours: activeHoursSchema.optional(),
  custom: z
    .object({
      breakIntervalMin: z.number().int().min(5).max(120).optional(),
      blinkReminder: z.boolean().optional(),
      hydrationReminder: z.boolean().optional(),
      windDown: z.boolean().optional(),
    })
    .optional(),
});

export async function generatePlan(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const body = generateSchema.parse(req.body);
  const plan = await coachService.generatePlan({ userId, ...body });
  res.status(201).json(coachService.toLocalReminders(plan));
}

export async function getPlan(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const plan = await coachService.getPlan(userId);
  res.status(200).json({ plan: plan ? coachService.toLocalReminders(plan) : null });
}

export const updateSchema = z.object({
  activeHours: activeHoursSchema.optional(),
  active: z.boolean().optional(),
  reminders: z
    .array(
      z.object({
        type: reminderType,
        enabled: z.boolean().optional(),
        intervalMin: z.number().int().min(5).max(120).optional(),
        atTime: endHhmm.optional(),
      }),
    )
    .optional(),
});

export async function updatePlan(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const patch = updateSchema.parse(req.body);
  const plan = await coachService.updatePlan(userId, patch);
  res.status(200).json(coachService.toLocalReminders(plan));
}

const sessionSchema = z.object({
  exerciseId: z.string().min(1),
  durationSec: z.number().int().min(1).max(60 * 60),
});

export async function logSession(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const { exerciseId, durationSec } = sessionSchema.parse(req.body);
  const result = await coachService.logExerciseSession(userId, exerciseId, durationSec);
  res.status(201).json(result);
}

export async function streak(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const result = await coachService.getStreak(userId);
  res.status(200).json(result);
}
