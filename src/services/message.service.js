
import { Message } from '../models/index.js';


/**
 * Save a chat message to MongoDB.
 *
 * roomId: MongoDB Room document ID
 * senderId: MongoDB User document ID
 */
export async function persistMessage({
  roomId,
  senderId,
  content,
  type = 'text'
}) {
  const message = await Message.create({
    room: roomId,
    sender: senderId,
    content,
    type
  });

  // Return a safe client-facing representation.
  return {
    id: message._id.toString(),
    room: roomId.toString(),
    sender: senderId.toString(),
    content: message.content,
    type: message.type,
    createdAt: message.createdAt
  };
}

/**
 * Retrieve recent messages for a room.
 */
export async function getRecentMessages({
  roomId,
  limit = 50
}) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 50, 1),
    100
  );

  const messages = await Message.find({
    room: roomId
  })
    .sort({
      createdAt: -1,
      _id: -1
    })
    .limit(safeLimit)
    .populate('sender', 'username displayName')
    .lean();

  return messages.reverse();
}
