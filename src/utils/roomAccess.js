import { RoomMember } from '../models/index.js';
import { AppError } from './AppError.js';

export async function ensureRoomAccess(room, userId) {
  // Public rooms can be read without room membership.
  if (!room.isPrivate) return;

  // Private rooms require an authenticated user.
  if (!userId) {
    throw new AppError(
      'Authentication required',
      401,
      'AUTH_REQUIRED'
    );
  }

  // Check whether this user belongs to this room.
  const isMember = await RoomMember.exists({
    room: room._id,
    user: userId,
  });

  if (!isMember) {
    throw new AppError(
      'You do not have access to this room',
      403,
      'ROOM_ACCESS_DENIED'
    );
  }
}