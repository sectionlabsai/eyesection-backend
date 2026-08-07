import { Router } from 'express';
import * as deviceController from '../controllers/device.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// FCM device tokens for server-sent push notifications.
router.post('/token', asyncHandler(deviceController.register));
router.delete('/token', asyncHandler(deviceController.unregister));

export default router;
