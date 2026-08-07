import { Router } from 'express';
import * as comfortController from '../controllers/comfort.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

// All comfort endpoints are personal to the signed-in user.
router.use(requireAuth);

router.post('/', asyncHandler(comfortController.submit));
router.get('/history', asyncHandler(comfortController.history));
router.get('/today', asyncHandler(comfortController.today));

// Screen Comfort Checks — ergonomic/behavioural tips only, never vision tests.
router.post('/checks/screen-distance', asyncHandler(comfortController.screenDistanceCheck));
router.post('/checks/brightness', asyncHandler(comfortController.brightnessCheck));
router.post('/checks/break-habit', asyncHandler(comfortController.breakHabitCheck));

export default router;
