import { Router } from 'express';
import * as reportController from '../controllers/report.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/latest', asyncHandler(reportController.latest));
router.get('/', asyncHandler(reportController.list));

export default router;
