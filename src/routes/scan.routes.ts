import { Router } from 'express';
import * as scanController from '../controllers/scan.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { requireConsent } from '../middleware/consent';
import { requirePremium } from '../services/entitlement.service';

const router = Router();

// Both endpoints use optionalAuth so the anonymous first-scan flow works.
// requireConsent blocks signed-in users who haven't accepted terms + privacy
// (anonymous first-scan callers pass through — see the middleware).
router.post('/upload', optionalAuth, requireConsent, asyncHandler(scanController.upload));
// List the caller's own scan history. Declared before '/:id' so 'GET /scans'
// isn't captured by the id param route.
router.get('/', optionalAuth, asyncHandler(scanController.list));
router.get('/:id', optionalAuth, asyncHandler(scanController.getById));
// On-demand routine regeneration — premium-only, daily-capped (see service).
router.post(
  '/:id/routine/regenerate',
  requireAuth,
  requirePremium,
  asyncHandler(scanController.regenerateRoutine),
);

export default router;
