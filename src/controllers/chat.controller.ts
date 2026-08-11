import { Request, Response } from 'express';
import { z } from 'zod';
import * as chatService from '../services/chat.service';
import { requireUser } from '../services/comfort.service';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(2000),
});

// Client sends the running conversation; the trailing message must be the user's.
// `sessionId` threads this turn onto an existing conversation (omit for a new one).
const chatSchema = z.object({
  messages: z.array(messageSchema).min(1).max(40),
  sessionId: z.string().min(1).max(64).optional(),
});

export async function chat(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const { messages, sessionId } = chatSchema.parse(req.body);
  const reply = await chatService.chat({ userId, messages, sessionId });
  res.status(200).json(reply);
}

export async function listSessions(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const sessions = await chatService.listChatSessions(userId);
  res.status(200).json({ sessions });
}

export async function getSession(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const session = await chatService.getChatSession(userId, req.params.id);
  res.status(200).json(session);
}

export async function deleteSession(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  await chatService.deleteChatSession(userId, req.params.id);
  res.status(204).send();
}
