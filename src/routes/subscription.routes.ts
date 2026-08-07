import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/status', asyncHandler(subscriptionController.status));
router.post('/link', asyncHandler(subscriptionController.link));
// Pre-launch simulated purchase — persists a trial to the DB so entitlement is
// consistent everywhere. Auto-disabled once RevenueCat is configured.
router.post('/simulate', asyncHandler(subscriptionController.simulate));

export default router;
