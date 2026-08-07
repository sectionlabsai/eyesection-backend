import { Schema, model, Document } from 'mongoose';

export type ExerciseCategory = 'relaxation' | 'focus_relief' | 'screen_break';
export const EXERCISE_CATEGORIES: ExerciseCategory[] = [
  'relaxation',
  'focus_relief',
  'screen_break',
];

export interface IExercise extends Document {
  exerciseId: string; // stable slug; matches ExerciseSession.exerciseId
  title: string;
  description: string;
  /** Short “why this helps” education copy (wellness framing only). */
  whyItHelps: string;
  /** When to reach for this routine (e.g. after long screen sessions). */
  bestFor: string;
  /** Soft safety notes — never medical advice. */
  cautions: string;
  durationSec: number;
  steps: string[];
  /** Seconds per step; length should match `steps`. Sum ≈ durationSec. */
  stepDurationsSec: number[];
  category: ExerciseCategory;
  premium: boolean;
  order: number; // display order in the library
  createdAt: Date;
  updatedAt: Date;
}

const exerciseSchema = new Schema<IExercise>(
  {
    exerciseId: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    whyItHelps: { type: String, default: '' },
    bestFor: { type: String, default: '' },
    cautions: { type: String, default: '' },
    durationSec: { type: Number, required: true },
    steps: { type: [String], default: [] },
    stepDurationsSec: { type: [Number], default: [] },
    category: {
      type: String,
      enum: EXERCISE_CATEGORIES,
      required: true,
    },
    premium: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

exerciseSchema.index({ order: 1 });

export const Exercise = model<IExercise>('Exercise', exerciseSchema);
