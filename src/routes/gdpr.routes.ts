import { Router } from 'express';
import * as gdprController from '../controllers/gdpr.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.post('/export', asyncHandler(gdprController.requestExport));
router.get('/export/:jobId', asyncHandler(gdprController.exportStatus));

export default router;
