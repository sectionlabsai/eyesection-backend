import { Schema, model, Document, Types } from 'mongoose';

export interface IReport extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  weekStart: Date;
  freshnessAvg: number;
  comfortAvg: number;
  bestDay?: string;
  worstDay?: string;
  breakCompliancePct: number;
  highlights: string[];
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<IReport>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    weekStart: { type: Date, required: true },
    freshnessAvg: { type: Number, default: 0 },
    comfortAvg: { type: Number, default: 0 },
    bestDay: String,
    worstDay: String,
    breakCompliancePct: { type: Number, default: 0 },
    highlights: { type: [String], default: [] },
  },
  { timestamps: true },
);

// One report per user per week; also serves paginated history.
reportSchema.index({ userId: 1, weekStart: -1 }, { unique: true });

export const Report = model<IReport>('Report', reportSchema);
