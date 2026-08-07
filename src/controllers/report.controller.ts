import { Request, Response } from 'express';
import { z } from 'zod';
import * as reportService from '../services/report.service';
import { requireUser } from '../services/comfort.service';

export async function latest(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const report = await reportService.getLatest(userId);
  res.status(200).json({ report });
}

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export async function list(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const { page, limit } = listSchema.parse(req.query);
  const result = await reportService.getPaginated(userId, page, limit);
  res.status(200).json(result);
}
