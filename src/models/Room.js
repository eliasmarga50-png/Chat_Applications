import mongoose from 'mongoose';

const { Schema } = mongoose;

const roomSchema = new Schema(
  {
    slug: {
      type: String,
      required: [true, 'Slug is required'],
      trim: true,
      lowercase: true,
      maxlength: 32,
      match: [/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers and hyphens'],
    },
    name: { type: String, required: true, trim: true, maxlength: 64 }, // e.g. "#javascript"
    description: { type: String, trim: true, maxlength: 280 },
    tags: { type: [String], default: [] },
    isPrivate: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

roomSchema.index({ slug: 1 }, { unique: true });          // lookup by slug
roomSchema.index({ isPrivate: 1, name: 1 });              // "list public rooms A-Z"

export const Room = mongoose.models.Room ?? mongoose.model('Room', roomSchema);