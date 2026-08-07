import { Schema, model, Document, Types } from 'mongoose';

/**
 * Audit log of admin-initiated push notifications (EB-12 dashboard).
 * One row per send — targeted user or broadcast segment — so the admin
 * panel can render a "recently sent" history.
 */
export interface IAdminNotificationLog extends Document {
  _id: Types.ObjectId;
  title: string;
  body: string;
  audienceLabel: string; // e.g. "All users", "Premium users", "Single user"
  segment?: string; // all | premium | free | trial (broadcasts only)
  userId?: string; // targeted single user (direct sends only)
  recipientCount: number;
  sentByAdminId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const adminNotificationLogSchema = new Schema<IAdminNotificationLog>(
  {
    title: { type: String, required: true },
    body: { type: String, required: true },
    audienceLabel: { type: String, required: true },
    segment: String,
    userId: String,
    recipientCount: { type: Number, default: 0 },
    sentByAdminId: { type: Schema.Types.ObjectId, ref: 'AdminUser' },
  },
  { timestamps: true },
);

adminNotificationLogSchema.index({ createdAt: -1 });

export const AdminNotificationLog = model<IAdminNotificationLog>(
  'AdminNotificationLog',
  adminNotificationLogSchema,
);
