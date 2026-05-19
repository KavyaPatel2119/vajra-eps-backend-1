import { Schema, model, Document } from 'mongoose';

export interface IRole extends Document {
  _id: string;
  name: 'STUDENT' | 'FACULTY';
  description: string;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

const roleSchema = new Schema<IRole>(
  {
    name: {
      type: String,
      enum: ['STUDENT', 'FACULTY'],
      unique: true,
      required: true,
    },
    description: { type: String, required: true },
    permissions: [{ type: String }],
  },
  { timestamps: true }
);

roleSchema.index({ name: 1 }, { unique: true });

export const Role = model<IRole>('Role', roleSchema);
