import mongoose from 'mongoose';

const { Schema } = mongoose;

// Embedded developer code snippet.
const codeSnippetSchema = new Schema(
  {
    language: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 30,
      default: 'plaintext',
    },

    filename: {
      type: String,
      trim: true,
      maxlength: 255,
    },

    code: {
      type: String,
      required: [true, 'Code snippet cannot be empty'],
      maxlength: [
        20000,
        'Snippet too large (max 20,000 chars)',
      ],
    },
  },
  { _id: false }
);

// Main message schema.
const messageSchema = new Schema(
  {
    room: {
      type: Schema.Types.ObjectId,
      ref: 'Room',
      required: true,
    },

    sender: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    type: {
      type: String,
      enum: ['text', 'code', 'system'],
      default: 'text',
    },

    content: {
      type: String,

      // Raw message limit is 4,000 characters.
      // Sanitized HTML may expand the stored content.
      maxlength: [
        20000,
        'Message too long (max 20,000 stored chars)',
      ],
    },

    codeSnippet: {
      type: codeSnippetSchema,
      default: undefined,
    },

    editedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Cross-field validation.
messageSchema.pre('validate', function () {
  const hasContent =
    typeof this.content === 'string' &&
    this.content.trim().length > 0;

  const hasCode =
    typeof this.codeSnippet?.code === 'string' &&
    this.codeSnippet.code.trim().length > 0;

  if (this.type === 'text') {
    if (!hasContent) {
      this.invalidate(
        'content',
        'Text messages cannot be empty'
      );
    }

    if (this.codeSnippet) {
      this.invalidate(
        'codeSnippet',
        'Text messages cannot contain code snippets'
      );
    }
  }

  if (this.type === 'code') {
    if (!hasCode) {
      this.invalidate(
        'codeSnippet',
        'Code messages must contain a non-empty code snippet'
      );
    }
  }

  if (this.type === 'system') {
    if (!hasContent) {
      this.invalidate(
        'content',
        'System messages cannot be empty'
      );
    }

    if (this.codeSnippet) {
      this.invalidate(
        'codeSnippet',
        'System messages cannot contain code snippets'
      );
    }
  }
});

// Room message history.
messageSchema.index({
  room: 1,
  createdAt: -1,
  _id: -1,
});

// User activity history.
messageSchema.index({
  sender: 1,
  createdAt: -1,
});

// Export model.
export const Message =
  mongoose.models.Message ??
  mongoose.model('Message', messageSchema);