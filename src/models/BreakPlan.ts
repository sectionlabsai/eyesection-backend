import { Schema, model, Document, Types } from 'mongoose';

export type BreakTemplate =
  | 'screen_worker'
  | 'night_phone'
  | 'gamer'
  | 'student'
  | 'driver';

export type ReminderType = '2020' | 'blink' | 'hydrate' | 'winddown';

export interface IReminder {
  type: ReminderType;
  intervalMin?: number; // for recurring reminders
  atTime?: string; // "HH:mm" for fixed-time reminders (e.g. winddown)
  enabled: boolean;
}

export interface IBreakPlan extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  template: BreakTemplate | string;
  reminders: IReminder[];
  activeHours: { start: string; end: string };
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const reminderSchema = new Schema<IReminder>(
  {
    type: {
      type: String,
      enum: ['2020', 'blink', 'hydrate', 'winddown'],
      required: true,
    },
    intervalMin: Number,
    atTime: String,
    enabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const breakPlanSchema = new Schema<IBreakPlan>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    template: { type: String, required: true },
    reminders: { type: [reminderSchema], default: [] },
    activeHours: {
      start: { type: String, default: '09:00' },
      end: { type: String, default: '22:00' },
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export const BreakPlan = model<IBreakPlan>('BreakPlan', breakPlanSchema);
