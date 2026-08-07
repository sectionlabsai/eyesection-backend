import { Router } from 'express';
import * as webhookController from '../controllers/webhook.controller';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

// Authenticated by the RevenueCat shared secret in the controller, not by a
// user token. Mounted without the default IP rate limit — retries are legit.
router.post('/revenuecat', asyncHandler(webhookController.revenuecat));

export default router;
