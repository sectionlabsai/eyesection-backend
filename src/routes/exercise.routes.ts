import { Router } from 'express';
import * as exerciseController from '../controllers/exercise.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { optionalAuth } from '../middleware/auth';

const router = Router();

// optionalAuth — free/anonymous users see free routines + locked premium previews.
router.get('/', optionalAuth, asyncHandler(exerciseController.list));

export default router;
