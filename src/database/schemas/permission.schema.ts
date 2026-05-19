import { Schema, model, Document } from 'mongoose';

export interface IPermission extends Document {
  _id: string;
  permissionId: string;
  name: string;
  description: string;
  resource: string;
  action: string;
  createdAt: Date;
  updatedAt: Date;
}

const permissionSchema = new Schema<IPermission>(
  {
    permissionId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, required: true },
    resource: { type: String, required: true },
    action: { type: String, required: true },
  },
  { timestamps: true }
);

permissionSchema.index({ permissionId: 1 }, { unique: true });
permissionSchema.index({ resource: 1, action: 1 });

export const Permission = model<IPermission>('Permission', permissionSchema);
