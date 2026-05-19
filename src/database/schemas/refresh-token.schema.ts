import { Schema, model, Document } from 'mongoose';

export interface IRefreshToken extends Document {
  _id: string;
  tokenId: string;
  userId: string;
  deviceId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
  replacedByTokenId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    tokenId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    deviceId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    replacedByTokenId: String,
  },
  { timestamps: true }
);

refreshTokenSchema.index({ tokenId: 1 }, { unique: true });
refreshTokenSchema.index({ userId: 1, deviceId: 1, revokedAt: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = model<IRefreshToken>('RefreshToken', refreshTokenSchema);
