import { Schema, model, Document, Types } from 'mongoose';
import { LEVELS, Level, FRESHNESS_BANDS, FreshnessBand } from '../types/levels';

export type ScanStatus = 'pending' | 'processing' | 'complete' | 'failed';

interface ImageRef {
  raw?: string; // S3 key, cleared by the 24h retention job (EB-04)
  thumb?: string; // S3 key, kept 90 days
  eyeThumb?: string; // S3 key of the eye-region crop thumbnail (front only), kept 90 days
}

export interface IEyeScan extends Document {
  _id: Types.ObjectId;
  userId?: Types.ObjectId; // optional — first scan can be anonymous
  status: ScanStatus;
  images: {
    front: ImageRef;
    closeup?: ImageRef;
  };
  geometry?: {
    eyeOpennessL: number;
    eyeOpennessR: number;
    symmetry: number;
  };
  // Full geometry blob as posted by the client (on-device ML Kit landmarks +
  // crop rectangles). Persisted so the EB-05 pipeline can crop under-eye/cheek/iris.
  geometryRaw?: unknown;
  analysis?: {
    freshnessScore: number;
    band: FreshnessBand;
    darkCircles: { level: Level; lDelta: number };
    puffiness: { level: Level };
    redness: { level: Level; aValue: number };
    tiredLook: { level: Level };
    // Fine lines: level = fine-line prominence (none = smooth).
    fineLines: { level: Level; textureValue: number };
    // Radiance: level = DULLNESS (none = radiant), so `none` reads as "Good".
    radiance: { level: Level; dullnessValue: number };
    symmetryScore: number;
    subScores?: Record<string, number>;
    routine?: unknown;
  };
  iris?: {
    colorCategory: string;
    colorName: string;
    hex: string;
    description: string;
    styling: unknown;
  };
  aiRaw?: unknown; // raw vision-model + LAB values, retained for audit
  errorReason?: string; // internal only, never surfaced to users
  rawDeleteAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const imageRefSchema = new Schema<ImageRef>(
  { raw: String, thumb: String, eyeThumb: String },
  { _id: false },
);

const levelField = { type: String, enum: LEVELS as unknown as string[] };

const eyeScanSchema = new Schema<IEyeScan>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'complete', 'failed'],
      default: 'pending',
      index: true,
    },
    images: {
      front: { type: imageRefSchema, default: () => ({}) },
      closeup: { type: imageRefSchema },
    },
    geometry: {
      type: new Schema(
        {
          eyeOpennessL: Number,
          eyeOpennessR: Number,
          symmetry: Number,
        },
        { _id: false },
      ),
    },
    geometryRaw: Schema.Types.Mixed,
    analysis: {
      type: new Schema(
        {
          freshnessScore: Number,
          band: { type: String, enum: FRESHNESS_BANDS as unknown as string[] },
          darkCircles: { level: levelField, lDelta: Number },
          puffiness: { level: levelField },
          redness: { level: levelField, aValue: Number },
          tiredLook: { level: levelField },
          fineLines: { level: levelField, textureValue: Number },
          radiance: { level: levelField, dullnessValue: Number },
          symmetryScore: Number,
          subScores: Schema.Types.Mixed,
          routine: Schema.Types.Mixed,
        },
        { _id: false },
      ),
    },
    iris: {
      type: new Schema(
        {
          colorCategory: String,
          colorName: String,
          hex: String,
          description: String,
          styling: Schema.Types.Mixed,
        },
        { _id: false },
      ),
    },
    aiRaw: Schema.Types.Mixed,
    errorReason: String,
    rawDeleteAt: { type: Date, index: true },
  },
  { timestamps: true },
);

// History queries: a user's scans over time.
eyeScanSchema.index({ userId: 1, createdAt: -1 });

export const EyeScan = model<IEyeScan>('EyeScan', eyeScanSchema);
