import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { authRateLimit } from '../middleware/rateLimit';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Auth endpoints are rate-limited to 10/min/IP.
router.use(authRateLimit);

router.post('/register', asyncHandler(authController.register));
router.post('/login', asyncHandler(authController.login));
router.post('/social', asyncHandler(authController.social));
router.post('/anonymous', asyncHandler(authController.anonymous));
router.post('/upgrade', requireAuth, asyncHandler(authController.upgrade));
router.post('/refresh', asyncHandler(authController.refresh));
router.post('/forgot-password', asyncHandler(authController.forgotPassword));
router.post('/reset-password', asyncHandler(authController.resetPassword));
router.get('/me', requireAuth, asyncHandler(authController.me));

export default router;
