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
// Ensures a Firebase account exists for the email (esp. legacy bcrypt users);
// the client then triggers Firebase's own sendPasswordResetEmail. There is no
// server-side reset-password endpoint — Firebase owns the password change.
router.post('/forgot-password', asyncHandler(authController.forgotPassword));
router.get('/me', requireAuth, asyncHandler(authController.me));

export default router;
