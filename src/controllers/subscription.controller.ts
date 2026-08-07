import { Request, Response } from 'express';
import * as subscriptionService from '../services/subscription.service';
import { requireUser } from '../services/comfort.service';

export async function status(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const result = await subscriptionService.getStatus(userId);
  res.status(200).json(result);
}

export async function link(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const result = await subscriptionService.linkAppUser(userId);
  res.status(200).json(result);
}

export async function simulate(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const plan = (req.body as { plan?: string } | undefined)?.plan;
  const result = await subscriptionService.simulateTrial(userId, plan);
  res.status(200).json(result);
}
