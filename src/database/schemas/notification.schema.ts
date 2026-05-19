import { Schema, model, Document } from 'mongoose';

export interface INotification extends Document {
  _id: string;
  notificationId: string;
  userId: string;
  type: 'EXAM_STARTED' | 'EXAM_REMINDER' | 'UFM_DETECTED' | 'RESULT_PUBLISHED' | 'SYSTEM_ALERT';
  title: string;
  message: string;
  relatedId?: string; // examId, sessionId, ufmId, etc.
  isRead: boolean;
  readAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    notificationId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    type: {
      type: String,
      enum: ['EXAM_STARTED', 'EXAM_REMINDER', 'UFM_DETECTED', 'RESULT_PUBLISHED', 'SYSTEM_ALERT'],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    relatedId: String,
    isRead: { type: Boolean, default: false },
    readAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

notificationSchema.index({ notificationId: 1 }, { unique: true });
notificationSchema.index({ userId: 1, isRead: 1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL

export const Notification = model<INotification>('Notification', notificationSchema);
