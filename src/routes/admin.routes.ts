import { Router } from 'express';
import * as admin from '../controllers/admin.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAdmin, requireSuperadmin } from '../middleware/adminAuth';
import { authRateLimit } from '../middleware/rateLimit';

const router = Router();

// Public admin auth. The strict 10/min/IP limiter (not the 100/min default the
// router is otherwise mounted with) throttles credential brute-forcing; the
// service layer adds per-account lockout on top.
router.post('/auth/login', authRateLimit, asyncHandler(admin.login));

// Everything below requires a valid admin token.
router.use(requireAdmin);

router.get('/auth/me', asyncHandler(admin.me));

router.get('/stats/overview', asyncHandler(admin.statsOverview));
router.get('/stats/growth', asyncHandler(admin.statsGrowth));
router.get('/stats/scans', asyncHandler(admin.statsScans));
router.get('/stats/revenue', asyncHandler(admin.statsRevenue));
router.get('/stats/needs-attention', asyncHandler(admin.needsAttention));

// Users
router.get('/users', asyncHandler(admin.listUsers));
router.get('/users/:id', asyncHandler(admin.getUser));
router.patch('/users/:id/status', asyncHandler(admin.setUserStatus));
router.delete('/users/:id', requireSuperadmin, asyncHandler(admin.deleteUser));

// Scans
router.get('/scans', asyncHandler(admin.listScans));
router.get('/scans/:id', asyncHandler(admin.getScan));
router.post('/scans/:id/reprocess', asyncHandler(admin.reprocessScan));
// Irreversible photo deletion — superadmin only.
router.delete('/scans/:id/photos', requireSuperadmin, asyncHandler(admin.deleteScanPhotos));

// Storage
router.get('/storage/stats', asyncHandler(admin.storageStats));
router.get('/storage/pending-deletion', asyncHandler(admin.pendingDeletion));
// Bulk irreversible storage purge — superadmin only.
router.post('/storage/purge-expired', requireSuperadmin, asyncHandler(admin.purgeExpired));

// Subscriptions
router.get('/subscriptions', asyncHandler(admin.listSubscriptions));
router.get('/subscriptions/stats', asyncHandler(admin.subscriptionStats));
router.post('/subscriptions/:userId/refresh', asyncHandler(admin.refreshSubscription));

// Exercises
router.get('/exercises', asyncHandler(admin.listExercises));
router.patch('/exercises/:id', asyncHandler(admin.updateExercise));

// GDPR, notifications & health
router.get('/gdpr/requests', asyncHandler(admin.gdprRequests));
// Mass push to the user base — superadmin only.
router.post('/notifications/send', requireSuperadmin, asyncHandler(admin.sendNotification));
router.post('/notifications/estimate', asyncHandler(admin.estimateAudience));
router.get('/notifications/history', asyncHandler(admin.notificationHistory));
router.get('/system/health', asyncHandler(admin.systemHealth));
router.get('/system/jobs', asyncHandler(admin.listJobs));
// Bulk requeue of every failed job — superadmin only.
router.post('/system/jobs/retry-all', requireSuperadmin, asyncHandler(admin.retryAllJobs));
router.post('/system/jobs/:id/retry', asyncHandler(admin.retryJob));

export default router;
