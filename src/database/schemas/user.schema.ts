import { Schema, model, Document } from 'mongoose';

export interface IUser extends Document {
  _id: string;
  email: string;
  firstName: string;
  lastName: string;
  passwordHash: string;
  phoneNumber?: string;
  profileImage?: string;
  role: 'STUDENT' | 'FACULTY';
  collegeId?: string;
  department?: string;
  branch?: string;
  class?: string;
  division?: string;
  semester?: number;
  batch?: number;
  studentId?: string;
  facultyId?: string;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'BANNED';
  permissions: string[];
  failedLoginAttempts: number;
  lockUntil?: Date;
  lastLogin?: Date;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  isDeleted: boolean;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    passwordHash: { type: String, required: true },
    phoneNumber: String,
    profileImage: String,
    role: {
      type: String,
      enum: ['STUDENT', 'FACULTY'],
      default: 'STUDENT',
    },
    collegeId: { type: Schema.Types.ObjectId, ref: 'College' },
    department: String,
    branch: String,
    class: String,
    division: String,
    semester: Number,
    batch: Number,
    studentId: String,
    facultyId: String,
    status: {
      type: String,
      enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'BANNED'],
      default: 'ACTIVE',
    },
    permissions: [String],
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: Date,
    lastLogin: Date,
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
  },
  { timestamps: true }
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ studentId: 1 }, { unique: true, sparse: true });
userSchema.index({ facultyId: 1 }, { sparse: true });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ lockUntil: 1 });
userSchema.index({ createdAt: -1 });

export const User = model<IUser>('User', userSchema);
