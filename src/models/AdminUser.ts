import { Schema, model, Document, Types } from 'mongoose';

export type AdminRole = 'admin' | 'superadmin';

export interface IAdminUser extends Document {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  role: AdminRole;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const adminUserSchema = new Schema<IAdminUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'superadmin'], default: 'admin' },
    lastLoginAt: Date,
  },
  { timestamps: true },
);

export const AdminUser = model<IAdminUser>('AdminUser', adminUserSchema);
