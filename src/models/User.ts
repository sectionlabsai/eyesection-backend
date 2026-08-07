import { Schema, model, Document, Types } from 'mongoose';

export type AuthProvider = 'email' | 'google' | 'apple' | 'anonymous';
export type SubscriptionStatus = 'free' | 'trial' | 'active' | 'expired';
export type UserStatus = 'active' | 'suspended';

export interface IUser extends Document {
  _id: Types.ObjectId;
  email?: string; // absent for anonymous-first users until they upgrade
  passwordHash?: string;
  authProvider: AuthProvider;
  isAnonymous: boolean;
  firebaseUid?: string;
  displayName?: string;
  photoURL?: string;
  concerns: string[];
  // Onboarding-quiz answers persisted server-side (EB-13).
  goal?: string;
  careProducts: string[];
  baselineComfort?: string;
  screenProfile: {
    dailyScreenHours?: number;
    nightPhoneUse?: boolean;
    wearsGlasses?: boolean;
    role?: string;
  };
  irisColorCategory?: string;
  subscription: {
    status: SubscriptionStatus;
    plan?: string;
    entitlement?: string;
    expiresAt?: Date;
    rcAppUserId?: string;
    lastEventAt?: Date; // newest processed RevenueCat event — for idempotency
  };
  consent: {
    termsAt?: Date;
    privacyAt?: Date;
    marketing: boolean;
  };
  notificationPrefs: {
    breaks: boolean;
    comfort: boolean;
    results: boolean;
    marketing: boolean;
    quietStart: string;
    quietEnd: string;
    timezone: string;
  };
  status: UserStatus;
  lastActiveAt?: Date;
  fcmTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

const screenProfileSchema = new Schema(
  {
    dailyScreenHours: Number,
    nightPhoneUse: Boolean,
    wearsGlasses: Boolean,
    role: String,
  },
  { _id: false },
);

const subscriptionSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['free', 'trial', 'active', 'expired'],
      default: 'free',
    },
    plan: String,
    entitlement: String,
    expiresAt: Date,
    rcAppUserId: { type: String, index: true },
    lastEventAt: Date,
  },
  { _id: false },
);

const consentSchema = new Schema(
  {
    termsAt: Date,
    privacyAt: Date,
    marketing: { type: Boolean, default: false },
  },
  { _id: false },
);

const notificationPrefsSchema = new Schema(
  {
    breaks: { type: Boolean, default: true },
    comfort: { type: Boolean, default: true },
    results: { type: Boolean, default: true },
    marketing: { type: Boolean, default: false },
    quietStart: { type: String, default: '21:00' },
    quietEnd: { type: String, default: '08:00' },
    timezone: { type: String, default: 'UTC' },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      // Required for real accounts; anonymous-first users have no email until
      // they upgrade (EB-13). Sparse-unique so multiple anon users coexist.
      required: function (this: { isAnonymous?: boolean }): boolean {
        return !this.isAnonymous;
      },
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, select: false },
    authProvider: {
      type: String,
      enum: ['email', 'google', 'apple', 'anonymous'],
      required: true,
      default: 'email',
    },
    isAnonymous: { type: Boolean, default: false },
    firebaseUid: { type: String, index: true, sparse: true },
    displayName: String,
    photoURL: String,
    concerns: { type: [String], default: [] },
    goal: String,
    careProducts: { type: [String], default: [] },
    baselineComfort: String,
    screenProfile: { type: screenProfileSchema, default: () => ({}) },
    irisColorCategory: String,
    subscription: { type: subscriptionSchema, default: () => ({}) },
    consent: { type: consentSchema, default: () => ({}) },
    notificationPrefs: { type: notificationPrefsSchema, default: () => ({}) },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    lastActiveAt: Date,
    fcmTokens: { type: [String], default: [] },
  },
  { timestamps: true },
);

export const User = model<IUser>('User', userSchema);
