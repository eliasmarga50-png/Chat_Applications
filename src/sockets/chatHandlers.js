
import { Room } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { ensureRoomAccess } from '../utils/roomAccess.js';
import { realtimeStore } from '../services/realtimeStore.js';
import { consumeRateLimit } from '../middleware/rateLimit.js';
import { persistMessage } from '../services/message.service.js';
import { validateMessagePayload } from '../utils/messageValidation.js';

const SLUG_RE = /^[a-z0-9-]{1,32}$/i;
const MAX_ROOMS_PER_SOCKET = 20;
const RATE_MAX = 10;
const RATE_WINDOW_MS = 5_000;
const channel = (slug) => `room:${slug}`;

function toClientError(err) {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message };
  }
  console.error('[socket] unexpected handler error:', err);
  return { code: 'INTERNAL_ERROR', message: 'Something went wrong' };
}

function parseObjectPayload(value) {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new AppError('Payload must be a plain object', 400, 'INVALID_PAYLOAD');
  }
  return value;
}

function parseSlug(value) {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw new AppError('Invalid room slug', 400, 'INVALID_ROOM_SLUG');
  }
  return value.toLowerCase();
}

export async function registerChatHandlers(io, socket) {
  const user = socket.data.user;
  const connection = await realtimeStore.registerSocket(user.id, socket.id);

  // A client can disconnect while the initial Redis registration is pending.
  // Clean up immediately rather than missing the already-fired disconnect event.
  if (!socket.connected) {
    const cleanup = await realtimeStore.unregisterSocket(socket.id);
    if (cleanup?.isOfflineUser) {
      io.emit('presence:user_offline', { userId: cleanup.userId, onlineUsers: cleanup.onlineUsers });
      io.emit('presence:count', { onlineUsers: cleanup.onlineUsers });
    }
    return;
  }

  if (connection.isNewOnlineUser) {
    io.emit('presence:user_online', { userId: user.id, onlineUsers: connection.onlineUsers });
  }
  io.emit('presence:count', { onlineUsers: connection.onlineUsers });

  function on(event, handler) {
    socket.on(event, async (...args) => {
      const ack = typeof args.at(-1) === 'function' ? args.pop() : () => {};
      try {
        const result = await handler(args[0]);
        ack({ ok: true, ...result });
      } catch (err) {
        ack({ ok: false, error: toClientError(err) });
      }
    });
  }

  on('room:join', async (payload) => {
    const { slug } = parseObjectPayload(payload);
    const normalizedSlug = parseSlug(slug);
    const room = await Room.findOne({ slug: normalizedSlug }).lean();
    if (!room) throw new AppError(`Room "${normalizedSlug}" not found`, 404, 'ROOM_NOT_FOUND');
    await ensureRoomAccess(room, user.id);

    const ch = channel(room.slug);
    if (!socket.rooms.has(ch)) {
      const joinedRooms = [...socket.rooms].filter((name) => name.startsWith('room:'));
      if (joinedRooms.length >= MAX_ROOMS_PER_SOCKET) {
        throw new AppError('Too many rooms joined', 429, 'ROOM_LIMIT');
      }

      const membership = await realtimeStore.joinRoom(room.slug, user.id, socket.id);
      await socket.join(ch);
      if (membership.isFirstSocket) {
        socket.to(ch).emit('room:user_joined', { room: room.slug, user });
      }
    }

    return { room: { slug: room.slug, name: room.name } };
  });

  on('room:leave', async (payload) => {
    const { slug } = parseObjectPayload(payload);
    const normalizedSlug = parseSlug(slug);
    const ch = channel(normalizedSlug);

    if (socket.rooms.has(ch)) {
      const typing = await realtimeStore.setTyping(normalizedSlug, user.id, socket.id, false);
      if (typing.changed) {
        socket.to(ch).emit('typing:update', { room: normalizedSlug, userId: user.id, isTyping: false });
      }

      const membership = await realtimeStore.leaveRoom(normalizedSlug, user.id, socket.id);
      await socket.leave(ch);
      if (membership.isLastSocket) {
        io.to(ch).emit('room:user_left', { room: normalizedSlug, user });
      }
    }
    return { room: { slug: normalizedSlug } };
  });

  on('message:send', async (payload) => {
    const { slug, content } = validateMessagePayload(payload);
    const ch = channel(slug);
    if (!socket.rooms.has(ch)) throw new AppError('Join the room before sending messages', 403, 'NOT_IN_ROOM');

    const room = await Room.findOne({ slug }).lean();
    if (!room) throw new AppError(`Room "${slug}" not found`, 404, 'ROOM_NOT_FOUND');
    await ensureRoomAccess(room, user.id);

    const limit = await consumeRateLimit({
      key: `socket-message:${user.id}`,
      windowMs: RATE_WINDOW_MS,
      max: RATE_MAX,
    });
    if (!limit.allowed) {
      throw new AppError('You are sending messages too fast', 429, 'RATE_LIMITED');
    }

    const savedMessage = await persistMessage({
      roomId: room._id,
      senderId: user.id,
      content,
      type: 'text',
    });

    io.to(ch).emit('message:new', { ...savedMessage, room: slug, sender: user });

    const typing = await realtimeStore.setTyping(slug, user.id, socket.id, false);
    if (typing.changed) {
      socket.to(ch).emit('typing:update', { room: slug, userId: user.id, isTyping: false });
    }

    return { id: savedMessage.id, createdAt: savedMessage.createdAt };
  });

  on('typing:start', async (payload) => {
    const { slug } = parseObjectPayload(payload);
    const normalizedSlug = parseSlug(slug);
    const ch = channel(normalizedSlug);
    if (!socket.rooms.has(ch)) throw new AppError('Join the room before typing', 403, 'NOT_IN_ROOM');

    const room = await Room.findOne({ slug: normalizedSlug }).lean();
    if (!room) throw new AppError('Room not found', 404, 'ROOM_NOT_FOUND');
    await ensureRoomAccess(room, user.id);

    const result = await realtimeStore.setTyping(normalizedSlug, user.id, socket.id, true);
    if (result.changed) {
      socket.to(ch).emit('typing:update', { room: normalizedSlug, userId: user.id, isTyping: true });
    }
    return { room: normalizedSlug, isTyping: true };
  });

  on('typing:stop', async (payload) => {
    const { slug } = parseObjectPayload(payload);
    const normalizedSlug = parseSlug(slug);
    const ch = channel(normalizedSlug);
    if (!socket.rooms.has(ch)) throw new AppError('You are not in this room', 403, 'NOT_IN_ROOM');

    const result = await realtimeStore.setTyping(normalizedSlug, user.id, socket.id, false);
    if (result.changed) {
      socket.to(ch).emit('typing:update', { room: normalizedSlug, userId: user.id, isTyping: false });
    }
    return { room: normalizedSlug, isTyping: false };
  });

  socket.on('disconnect', async (reason) => {
    try {
      const result = await realtimeStore.unregisterSocket(socket.id);
      if (!result) return;

      for (const roomSlug of result.leftRooms) {
        io.to(channel(roomSlug)).emit('room:user_left', { room: roomSlug, user });
      }
      for (const typing of result.stoppedTyping) {
        io.to(channel(typing.roomSlug)).emit('typing:update', {
          room: typing.roomSlug,
          userId: typing.userId,
          isTyping: false,
        });
      }
      if (result.isOfflineUser) {
        io.emit('presence:user_offline', { userId: result.userId, onlineUsers: result.onlineUsers });
      }
      io.emit('presence:count', { onlineUsers: result.onlineUsers });
      console.log(`[presence] ${user.username} disconnected (${reason})`);
    } catch (error) {
      console.error('[presence] disconnect cleanup failed:', error);
    }
  });

  socket.on('error', (err) => {
    console.error(`[socket] error (${user.username}):`, err.message);
  });
}
