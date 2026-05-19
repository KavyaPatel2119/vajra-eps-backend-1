import { Schema, model, Document } from 'mongoose';

export interface IAuditLog extends Document {
  _id: string;
  auditId: string;
  userId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  changes: {
    field: string;
    oldValue: any;
    newValue: any;
  }[];
  ipAddress: string;
  userAgent: string;
  status: 'SUCCESS' | 'FAILURE';
  timestamp: Date;
  isImmutable: boolean;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    auditId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    action: { type: String, required: true },
    resourceType: { type: String, required: true },
    resourceId: String,
    changes: [
      {
        field: String,
        oldValue: Schema.Types.Mixed,
        newValue: Schema.Types.Mixed,
      },
    ],
    ipAddress: { type: String, required: true },
    userAgent: String,
    status: {
      type: String,
      enum: ['SUCCESS', 'FAILURE'],
      required: true,
    },
    timestamp: { type: Date, required: true, default: Date.now },
    isImmutable: { type: Boolean, default: true },
  },
  { timestamps: false }
);

// Prevent any updates to audit logs
auditLogSchema.pre('updateOne', function (next) {
  throw new Error('Audit logs cannot be modified');
});

auditLogSchema.pre('findOneAndUpdate', function (next) {
  throw new Error('Audit logs cannot be modified');
});

auditLogSchema.index({ auditId: 1 }, { unique: true });
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1 });
auditLogSchema.index({ timestamp: -1 });

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);
