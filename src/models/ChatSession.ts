import { Schema, model, Document, Types } from 'mongoose';

export type ChatRole = 'user' | 'assistant';

export interface IChatSessionMessage {
  role: ChatRole;
  content: string;
  at: Date;
}

/**
 * A persisted eye-area chat conversation (EB-13). The live turn is still
 * answered from the client-supplied history (see chat.service), but every
 * delivered turn is appended here so the user can browse and resume past
 * conversations ("Recent history"). Messages are embedded and capped so a single
 * document stays bounded; chat is daily-quota-limited so threads stay small.
 */
export interface IChatSession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  title: string;
  messages: IChatSessionMessage[];
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IChatSessionMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const chatSessionSchema = new Schema<IChatSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, default: 'New chat' },
    messages: { type: [messageSchema], default: [] },
    // Denormalized sort key so the "recent history" list can page by recency
    // without scanning the embedded array.
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Recent-first listing per user.
chatSessionSchema.index({ userId: 1, lastMessageAt: -1 });

export const ChatSession = model<IChatSession>('ChatSession', chatSessionSchema);
