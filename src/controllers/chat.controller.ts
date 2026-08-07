import { Request, Response } from 'express';
import { z } from 'zod';
import * as chatService from '../services/chat.service';
import { requireUser } from '../services/comfort.service';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(2000),
});

// Client sends the running conversation; the trailing message must be the user's.
const chatSchema = z.object({
  messages: z.array(messageSchema).min(1).max(40),
});

export async function chat(req: Request, res: Response): Promise<void> {
  const userId = requireUser(req.userId);
  const { messages } = chatSchema.parse(req.body);
  const reply = await chatService.chat({ userId, messages });
  res.status(200).json(reply);
}
