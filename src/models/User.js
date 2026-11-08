import mongoose from 'mongoose';

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: [true, 'Username is required'],
      trim: true,
      lowercase: true,
      minlength: [3, 'Username must be at least 3 characters'],
      maxlength: [32, 'Username must be at most 32 characters'],
      match: [/^[a-z0-9_]+$/, 'Username may only contain letters, numbers and underscores'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Email is not valid'],
    },
    // select:false => excluded from query results unless explicitly requested.
    // Hashing and login flow arrive in Step 4.
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, trim: true, maxlength: 64 },
    avatarUrl: { type: String, trim: true, maxlength: 2048 },
    role: { type: String, enum: ['member', 'moderator', 'admin'], default: 'member' },
    lastSeenAt: { type: Date },
  },
  { timestamps: true }
);

// Declared once here (not also as `unique: true` on the field) to avoid
// Mongoose's duplicate-index warning.
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ email: 1 }, { unique: true });

// Never leak sensitive/internal fields if a document is serialized.
userSchema.set('toJSON', {
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);