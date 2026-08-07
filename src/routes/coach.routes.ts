import { Router } from 'express';
import * as coachController from '../controllers/coach.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.post('/plan', asyncHandler(coachController.generatePlan));
router.get('/plan', asyncHandler(coachController.getPlan));
router.patch('/plan', asyncHandler(coachController.updatePlan));

router.post('/exercise-session', asyncHandler(coachController.logSession));
router.get('/streak', asyncHandler(coachController.streak));

export default router;
