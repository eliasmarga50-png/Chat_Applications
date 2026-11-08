import mongoose from 'mongoose';

const { Schema } = mongoose;

// Embedded subdocument: lives and dies with its message.
const codeSnippetSchema = new Schema(
  {
    language: { type: String, trim: true, lowercase: true, maxlength: 30, default: 'plaintext' },
    filename: { type: String, trim: true, maxlength: 255 },
    code: {
      type: String,
      required: [true, 'Code snippet cannot be empty'],
      maxlength: [20000, 'Snippet too large (max 20,000 chars); large files use streams in Step 5'],
    },
  },
  { _id: false }
);

const messageSchema = new Schema(
  {
    room: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['text', 'code', 'system'], default: 'text' },
    content: { type: String, trim: true, maxlength: [4000, 'Message too long (max 4000 chars)'] },
    // `default: undefined` => the field is absent (not an empty object) on plain text messages.
    codeSnippet: { type: codeSnippetSchema, default: undefined },
    editedAt: { type: Date },
  },
  { timestamps: true } // adds createdAt / updatedAt automatically
);

// Cross-field rules a single-field validator can't express.
messageSchema.pre('validate', function () {
  if (!this.content && !this.codeSnippet) {
    this.invalidate('content', 'A message needs text content or a code snippet');
  }
  if (this.type === 'code' && !this.codeSnippet) {
    this.invalidate('codeSnippet', 'A message of type "code" requires a codeSnippet');
  }
});

// Hot path: "latest N messages in a room", paginated by time.
// Equality (room) -> Sort (createdAt desc). Serves both the sort and the filter.
messageSchema.index({ room: 1, createdAt: -1 });

// Secondary path: a user's recent activity (profiles, moderation).
messageSchema.index({ sender: 1, createdAt: -1 });

export const Message = mongoose.models.Message ?? mongoose.model('Message', messageSchema);