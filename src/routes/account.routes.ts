import { Router } from 'express';
import * as gdprController from '../controllers/gdpr.controller';
import * as accountController from '../controllers/account.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

// Quiz / profile persistence and notification preferences (EB-13).
router.patch('/profile', asyncHandler(accountController.updateProfile));
router.patch('/notifications', asyncHandler(accountController.updateNotifications));

// Irreversible GDPR account deletion (re-auth enforced in the controller).
router.delete('/', asyncHandler(gdprController.deleteAccount));

export default router;
