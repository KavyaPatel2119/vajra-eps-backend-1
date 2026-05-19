import { Schema, model, Document } from 'mongoose';

export interface IDevice extends Document {
  _id: string;
  deviceId: string;
  userId: string;
  fingerprint: string;
  ipAddress: string;
  deviceName: string;
  osType: 'WINDOWS' | 'MAC' | 'LINUX' | 'ANDROID' | 'IOS';
  osVersion: string;
  browserType: string;
  isVerified: boolean;
  lastUsed: Date;
  createdAt: Date;
  updatedAt: Date;
  isBlocked: boolean;
}

const deviceSchema = new Schema<IDevice>(
  {
    deviceId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    fingerprint: { type: String, required: true },
    ipAddress: { type: String, required: true },
    deviceName: { type: String, required: true },
    osType: {
      type: String,
      enum: ['WINDOWS', 'MAC', 'LINUX', 'ANDROID', 'IOS'],
      required: true,
    },
    osVersion: String,
    browserType: String,
    isVerified: { type: Boolean, default: false },
    isBlocked: { type: Boolean, default: false },
    lastUsed: Date,
  },
  { timestamps: true }
);

deviceSchema.index({ deviceId: 1 }, { unique: true });
deviceSchema.index({ userId: 1 });
deviceSchema.index({ ipAddress: 1 });
deviceSchema.index({ lastUsed: -1 });

export const Device = model<IDevice>('Device', deviceSchema);
