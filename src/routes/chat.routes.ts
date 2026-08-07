import { Router } from 'express';
import * as chatController from '../controllers/chat.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.post('/', asyncHandler(chatController.chat));

export default router;
