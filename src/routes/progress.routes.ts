import { Router } from 'express';
import * as progressController from '../controllers/progress.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { requirePremium } from '../services/entitlement.service';

const router = Router();

router.use(requireAuth);

router.get('/freshness', asyncHandler(progressController.freshness));
// Before/after is a premium-only insight.
router.get('/before-after', requirePremium, asyncHandler(progressController.beforeAfter));

export default router;
