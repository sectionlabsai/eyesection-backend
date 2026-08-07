import { Router } from 'express';
import * as consentController from '../controllers/consent.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.get('/', asyncHandler(consentController.get));
router.post('/', asyncHandler(consentController.set));

export default router;
