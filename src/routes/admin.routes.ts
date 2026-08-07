import { Router } from 'express';
import * as admin from '../controllers/admin.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAdmin, requireSuperadmin } from '../middleware/adminAuth';

const router = Router();

// Public admin auth.
router.post('/auth/login', asyncHandler(admin.login));

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
router.delete('/scans/:id/photos', asyncHandler(admin.deleteScanPhotos));

// Storage
router.get('/storage/stats', asyncHandler(admin.storageStats));
router.get('/storage/pending-deletion', asyncHandler(admin.pendingDeletion));
router.post('/storage/purge-expired', asyncHandler(admin.purgeExpired));

// Subscriptions
router.get('/subscriptions', asyncHandler(admin.listSubscriptions));
router.get('/subscriptions/stats', asyncHandler(admin.subscriptionStats));
router.post('/subscriptions/:userId/refresh', asyncHandler(admin.refreshSubscription));

// Exercises
router.get('/exercises', asyncHandler(admin.listExercises));
router.patch('/exercises/:id', asyncHandler(admin.updateExercise));

// GDPR, notifications & health
router.get('/gdpr/requests', asyncHandler(admin.gdprRequests));
router.post('/notifications/send', asyncHandler(admin.sendNotification));
router.post('/notifications/estimate', asyncHandler(admin.estimateAudience));
router.get('/notifications/history', asyncHandler(admin.notificationHistory));
router.get('/system/health', asyncHandler(admin.systemHealth));
router.get('/system/jobs', asyncHandler(admin.listJobs));
router.post('/system/jobs/retry-all', asyncHandler(admin.retryAllJobs));
router.post('/system/jobs/:id/retry', asyncHandler(admin.retryJob));

export default router;
