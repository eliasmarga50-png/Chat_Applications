
import mongoose from 'mongoose';

const { Schema } = mongoose;

const uploadSchema = new Schema(
  {
    uploader: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    originalName: {
      type: String,
      required: true,
      maxlength: 255
    },

    storedName: {
      type: String,
      required: true,
      unique: true
    },

    mimeType: {
      type: String,
      required: true,
      maxlength: 100
    },

    size: {
      type: Number,
      required: true,
      min: 1
    },

    sha256: {
      type: String,
      required: true,
      minlength: 64,
      maxlength: 64
    }
  },
  {
    timestamps: true
  }
);

// Efficient user upload history.
uploadSchema.index({
  uploader: 1,
  createdAt: -1
});

export const Upload =
  mongoose.models.Upload ??
  mongoose.model('Upload', uploadSchema);
