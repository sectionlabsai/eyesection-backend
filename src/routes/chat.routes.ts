import { Router } from 'express';
import * as chatController from '../controllers/chat.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);

router.post('/', asyncHandler(chatController.chat));

// Persisted conversation history ("Recent history").
router.get('/sessions', asyncHandler(chatController.listSessions));
router.get('/sessions/:id', asyncHandler(chatController.getSession));
router.delete('/sessions/:id', asyncHandler(chatController.deleteSession));

export default router;
