import { Request, Response } from 'express';
import * as exerciseService from '../services/exercise.service';
import { userIsPremium } from '../services/entitlement.service';

export async function list(req: Request, res: Response): Promise<void> {
  // optionalAuth — anonymous callers are treated as free (locked previews).
  const isPremium = await userIsPremium(req.userId);
  const exercises = await exerciseService.listExercises(isPremium);
  res.status(200).json({ exercises });
}
