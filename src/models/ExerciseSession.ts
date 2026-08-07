import { Schema, model, Document, Types } from 'mongoose';

export interface IExerciseSession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  exerciseId: string;
  durationSec: number;
  completedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const exerciseSessionSchema = new Schema<IExerciseSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    exerciseId: { type: String, required: true },
    durationSec: { type: Number, required: true },
    completedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

exerciseSessionSchema.index({ userId: 1, completedAt: -1 });

export const ExerciseSession = model<IExerciseSession>(
  'ExerciseSession',
  exerciseSessionSchema,
);
