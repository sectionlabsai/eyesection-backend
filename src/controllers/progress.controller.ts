import { Request, Response } from 'express';
import { z } from 'zod';
import * as progressService from '../services/progress.service';
import { requireUser } from '../services/comfort.service';

const freshnessSchema = z.object({
  range: z.coerce.number().int().min(1).max(365).default(90),
});

export async function freshness(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const { range } = freshnessSchema.parse(req.query);
  const result = await progressService.freshnessTrend(userId, range);
  res.status(200).json(result);
}

export async function beforeAfter(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const result = await progressService.beforeAfter(userId);
  res.status(200).json(result);
}
