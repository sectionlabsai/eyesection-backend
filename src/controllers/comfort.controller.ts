import { Request, Response } from 'express';
import { z } from 'zod';
import * as comfortService from '../services/comfort.service';

const rating03 = z.number().int().min(0).max(3);

const submitSchema = z.object({
  screenHours: z.number().min(0).max(24),
  drynessFeel: rating03,
  tirednessFeel: rating03,
  sleepHours: z.number().min(0).max(24),
  breakCompliance: rating03,
  blinkCompliance: rating03,
  nightMode: z.boolean(),
  brightnessComfort: rating03,
  screenDistanceComfort: rating03,
});

export async function submit(req: Request, res: Response): Promise<void> {
  const userId = comfortService.requireUser(req.userId);
  const inputs = submitSchema.parse(req.body);
  const result = await comfortService.submitComfort({ userId, ...inputs });
  res.status(201).json(result);
}

const historySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export async function history(req: Request, res: Response): Promise<void> {
  const userId = comfortService.requireUser(req.userId);
  const { days } = historySchema.parse(req.query);
  const entries = await comfortService.getHistory(userId, days);
  res.status(200).json({ days, entries });
}

export async function today(req: Request, res: Response): Promise<void> {
  const userId = comfortService.requireUser(req.userId);
  const entry = await comfortService.getToday(userId);
  res.status(200).json({ entry });
}

const distanceSchema = z.object({ distanceCm: z.number().min(1).max(300) });

export async function screenDistanceCheck(req: Request, res: Response): Promise<void> {
  comfortService.requireUser(req.userId);
  const { distanceCm } = distanceSchema.parse(req.body);
  res.status(200).json(comfortService.screenDistanceCheck(distanceCm));
}

const ratingSchema = z.object({ rating: rating03 });

export async function brightnessCheck(req: Request, res: Response): Promise<void> {
  comfortService.requireUser(req.userId);
  const { rating } = ratingSchema.parse(req.body);
  res.status(200).json(comfortService.brightnessCheck(rating));
}

export async function breakHabitCheck(req: Request, res: Response): Promise<void> {
  comfortService.requireUser(req.userId);
  const { rating } = ratingSchema.parse(req.body);
  res.status(200).json(comfortService.breakHabitCheck(rating));
}
