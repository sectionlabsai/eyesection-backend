import { Schema, model, Document, Types } from 'mongoose';
import { COMFORT_BANDS, ComfortBand } from '../types/levels';

export interface IComfortEntry extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  date: Date; // day bucket — one entry per user per day (upsert)
  inputs: {
    screenHours: number;
    drynessFeel: number; // 0-3
    tirednessFeel: number; // 0-3
    sleepHours: number;
    breakCompliance: number; // 0-3
    blinkCompliance: number; // 0-3
    nightMode: boolean;
    brightnessComfort: number; // 0-3
    screenDistanceComfort: number; // 0-3
  };
  comfortScore: number; // 0-100, computed in code
  band: ComfortBand;
  createdAt: Date;
  updatedAt: Date;
}

const rating03 = { type: Number, min: 0, max: 3 };

const comfortEntrySchema = new Schema<IComfortEntry>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    date: { type: Date, required: true, index: true },
    inputs: {
      screenHours: { type: Number, default: 0 },
      drynessFeel: rating03,
      tirednessFeel: rating03,
      sleepHours: { type: Number, default: 0 },
      breakCompliance: rating03,
      blinkCompliance: rating03,
      nightMode: { type: Boolean, default: false },
      brightnessComfort: rating03,
      screenDistanceComfort: rating03,
    },
    comfortScore: { type: Number, required: true },
    band: { type: String, enum: COMFORT_BANDS as unknown as string[], required: true },
  },
  { timestamps: true },
);

// One entry per user per day; also serves history-by-date queries.
comfortEntrySchema.index({ userId: 1, date: 1 }, { unique: true });

export const ComfortEntry = model<IComfortEntry>('ComfortEntry', comfortEntrySchema);
