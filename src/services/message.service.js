import { Message } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { sanitizeContent } from '../utils/sanitizeContent.js';

const MAX_RAW_CONTENT = 4000;
const MAX_STORED_CONTENT = 20000;

/**
 * Save a sanitized chat message to MongoDB.
 *
 * roomId: MongoDB Room document ID
 * senderId: MongoDB User document ID
 */
export async function persistMessage({
  roomId,
  senderId,
  content,
  type = 'text',
}) {
  if (typeof content !== 'string') {
    throw new AppError(
      'Message content must be a string',
      400,
      'INVALID_MESSAGE'
    );
  }

  if (
    content.trim().length === 0 ||
    content.length > MAX_RAW_CONTENT
  ) {
    throw new AppError(
      `Message content must contain 1-${MAX_RAW_CONTENT} characters`,
      400,
      'INVALID_MESSAGE'
    );
  }

  // Sanitize before saving.
  const safeContent = sanitizeContent(content);

  if (safeContent.trim().length === 0) {
    throw new AppError(
      'Message contains no acceptable content',
      400,
      'INVALID_MESSAGE'
    );
  }

  if (safeContent.length > MAX_STORED_CONTENT) {
    throw new AppError(
      'Sanitized message is too large',
      400,
      'INVALID_MESSAGE'
    );
  }

  // Only sanitized content reaches MongoDB.
  const message = await Message.create({
    room: roomId,
    sender: senderId,
    content: safeContent,
    type,
  });

  // Return a client-facing representation.
  return {
    id: message._id.toString(),
    room: roomId.toString(),
    sender: senderId.toString(),
    content: message.content,
    type: message.type,
    createdAt: message.createdAt,
  };
}

/**
 * Retrieve recent messages for a room.
 */
export async function getRecentMessages({
  roomId,
  limit = 50,
}) {
  const safeLimit = Math.min(
    Math.max(Number(limit) || 50, 1),
    100
  );

  const messages = await Message.find({
    room: roomId,
  })
    .sort({
      createdAt: -1,
      _id: -1,
    })
    .limit(safeLimit)
    .populate('sender', 'username displayName')
    .lean();

  return messages.reverse();
}