
import mongoose from 'mongoose';

const { Schema } = mongoose;

const roomMemberSchema = new Schema(
  {
    // The room this membership belongs to.
    room: {
      type: Schema.Types.ObjectId,
      ref: 'Room',
      required: true
    },

    // The user who belongs to this room.
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    // The user's permission level in this particular room.
    role: {
      type: String,
      enum: ['owner', 'moderator', 'member'],
      default: 'member'
    }
  },
  {
    timestamps: true
  }
);

// Prevent the same user from joining the same room twice.
roomMemberSchema.index(
  { room: 1, user: 1 },
  { unique: true }
);

// Find all rooms a particular user belongs to.
roomMemberSchema.index({
  user: 1,
  createdAt: -1
});

// Find members of a room, optionally filtering by role.
roomMemberSchema.index({
  room: 1,
  role: 1
});

export const RoomMember =
  mongoose.models.RoomMember ??
  mongoose.model('RoomMember', roomMemberSchema);
