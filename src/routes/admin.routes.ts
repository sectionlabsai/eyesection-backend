import { Router } from 'express';
import * as admin from '../controllers/admin.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAdmin, requireSuperadmin } from '../middleware/adminAuth';

const router = Router();

// Public admin auth.
router.post('/auth/login', asyncHandler(admin.login));

// Everything below requires a valid admin token.
router.use(requireAdmin);

router.get('/stats/overview', asyncHandler(admin.statsOverview));

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
router.post('/storage/purge-expired', asyncHandler(admin.purgeExpired));

// Subscriptions
router.get('/subscriptions', asyncHandler(admin.listSubscriptions));
router.post('/subscriptions/:userId/refresh', asyncHandler(admin.refreshSubscription));

// Exercises
router.get('/exercises', asyncHandler(admin.listExercises));
router.patch('/exercises/:id', asyncHandler(admin.updateExercise));

// GDPR, notifications & health
router.get('/gdpr/requests', asyncHandler(admin.gdprRequests));
router.post('/notifications/send', asyncHandler(admin.sendNotification));
router.get('/system/health', asyncHandler(admin.systemHealth));

export default router;
