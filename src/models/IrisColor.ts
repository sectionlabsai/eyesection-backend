import { Schema, model, Document } from 'mongoose';

/**
 * Reference/seed collection for the iris-colour "fun feature" (EB-06).
 * Cosmetic/informational styling only — no health claims.
 */
export interface IIrisColor extends Document {
  category: string; // stable key, e.g. "deep_brown"
  name: string; // friendly name, e.g. "Deep Brown"
  hex: string;
  description: string;
  styling: {
    makeup: string[];
    lensIdeas: string[];
    clothing: string[];
  };
}

const irisColorSchema = new Schema<IIrisColor>(
  {
    category: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    hex: { type: String, required: true },
    description: { type: String, default: '' },
    styling: {
      makeup: { type: [String], default: [] },
      lensIdeas: { type: [String], default: [] },
      clothing: { type: [String], default: [] },
    },
  },
  { timestamps: true },
);

export const IrisColor = model<IIrisColor>('IrisColor', irisColorSchema);
