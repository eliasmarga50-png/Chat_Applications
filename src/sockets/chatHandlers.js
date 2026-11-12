import { Room } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { ensureRoomAccess } from '../utils/roomAccess.js';

import { realtimeState } from '../services/realtimeState.js';
import { persistMessage } from '../services/message.service.js';

import {
  validateMessagePayload,
} from '../utils/messageValidation.js';

const SLUG_RE = /^[a-z0-9-]{1,32}$/i;
const MAX_ROOMS_PER_SOCKET = 20;

const RATE_MAX = 10;
const RATE_WINDOW_MS = 5_000;

const channel = (slug) => `room:${slug}`;

// ----------------------------------------
// RATE LIMITER
// ----------------------------------------

function createRateLimiter({ max, windowMs }) {
  let count = 0;
  let windowStart = Date.now();

  return () => {
    const now = Date.now();

    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }

    return ++count <= max;
  };
}

// ----------------------------------------
// ERROR HANDLING
// ----------------------------------------

function toClientError(err) {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
    };
  }

  console.error(
    '[socket] unexpected handler error:',
    err
  );

  return {
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong',
  };
}

// ----------------------------------------
// PAYLOAD VALIDATION
// ----------------------------------------

function parseObjectPayload(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
  ) {
    throw new AppError(
      'Payload must be a plain object',
      400,
      'INVALID_PAYLOAD'
    );
  }

  return value;
}

function parseSlug(value) {
  if (
    typeof value !== 'string' ||
    !SLUG_RE.test(value)
  ) {
    throw new AppError(
      'Invalid room slug',
      400,
      'INVALID_ROOM_SLUG'
    );
  }

  return value.toLowerCase();
}

// ----------------------------------------
// MAIN SOCKET HANDLERS
// ----------------------------------------

export function registerChatHandlers(io, socket) {
  const user = socket.data.user;

  const allowMessage = createRateLimiter({
    max: RATE_MAX,
    windowMs: RATE_WINDOW_MS,
  });

  // Register socket in the presence system.
  const connection = realtimeState.registerSocket(
    user.id,
    socket.id
  );

  // Notify clients when a user becomes online.
  if (connection.isNewOnlineUser) {
    io.emit('presence:user_online', {
      userId: user.id,
      onlineUsers: connection.onlineUsers,
    });
  }

  io.emit('presence:count', {
    onlineUsers: connection.onlineUsers,
  });

  // --------------------------------------
  // CENTRALIZED SOCKET EVENT WRAPPER
  // --------------------------------------

  function on(event, handler) {
    socket.on(event, async (...args) => {
      const ack =
        typeof args.at(-1) === 'function'
          ? args.pop()
          : () => {};

      try {
        const result = await handler(args[0]);

        ack({
          ok: true,
          ...result,
        });
      } catch (err) {
        ack({
          ok: false,
          error: toClientError(err),
        });
      }
    });
  }

  // --------------------------------------
  // ROOM JOIN
  // --------------------------------------

  on('room:join', async (payload) => {
    const data = parseObjectPayload(payload);
    const slug = parseSlug(data.slug);

    const room = await Room.findOne({
      slug,
    }).lean();

    if (!room) {
      throw new AppError(
        `Room "${slug}" not found`,
        404,
        'ROOM_NOT_FOUND'
      );
    }

    await ensureRoomAccess(room, user.id);

    const ch = channel(room.slug);

    if (!socket.rooms.has(ch)) {
      if (
        socket.rooms.size - 1 >= MAX_ROOMS_PER_SOCKET
      ) {
        throw new AppError(
          'Too many rooms joined',
          429,
          'ROOM_LIMIT'
        );
      }

      await socket.join(ch);

      socket.to(ch).emit('room:user_joined', {
        room: room.slug,
        user,
      });
    }

    return {
      room: {
        slug: room.slug,
        name: room.name,
      },
    };
  });

  // --------------------------------------
  // ROOM LEAVE
  // --------------------------------------

  on('room:leave', async (payload) => {
    const data = parseObjectPayload(payload);
    const slug = parseSlug(data.slug);
    const ch = channel(slug);

    if (socket.rooms.has(ch)) {
      const typing = realtimeState.setTyping(
        slug,
        user.id,
        socket.id,
        false
      );

      if (typing.changed) {
        socket.to(ch).emit('typing:update', {
          room: slug,
          userId: user.id,
          isTyping: false,
        });
      }

      await socket.leave(ch);

      socket.to(ch).emit('room:user_left', {
        room: slug,
        user,
      });
    }

    return {
      room: { slug },
    };
  });

  // --------------------------------------
  // MESSAGE SEND + SANITIZATION
  // --------------------------------------

  on('message:send', async (payload) => {
    // 1. Strictly validate the payload.
    const { slug, content } =
      validateMessagePayload(payload);

    const ch = channel(slug);

    // 2. Require room membership.
    if (!socket.rooms.has(ch)) {
      throw new AppError(
        'Join the room before sending messages',
        403,
        'NOT_IN_ROOM'
      );
    }

    // 3. Find the room.
    const room = await Room.findOne({
      slug,
    }).lean();

    if (!room) {
      throw new AppError(
        `Room "${slug}" not found`,
        404,
        'ROOM_NOT_FOUND'
      );
    }

    // 4. Verify room authorization.
    await ensureRoomAccess(room, user.id);

    // 5. Apply rate limiting.
    if (!allowMessage()) {
      throw new AppError(
        'You are sending messages too fast',
        429,
        'RATE_LIMITED'
      );
    }

    // 6. Sanitize and persist.
    // Sanitization occurs inside persistMessage().
    const savedMessage = await persistMessage({
      roomId: room._id,
      senderId: user.id,
      content,
      type: 'text',
    });

    // 7. Broadcast only persisted sanitized content.
    io.to(ch).emit('message:new', {
      ...savedMessage,
      room: slug,
      sender: user,
    });

    // 8. Stop typing after sending.
    const typing = realtimeState.setTyping(
      slug,
      user.id,
      socket.id,
      false
    );

    if (typing.changed) {
      socket.to(ch).emit('typing:update', {
        room: slug,
        userId: user.id,
        isTyping: false,
      });
    }

    // 9. Acknowledge the sender.
    return {
      id: savedMessage.id,
      createdAt: savedMessage.createdAt,
    };
  });

  // --------------------------------------
  // TYPING START
  // --------------------------------------

  on('typing:start', async (payload) => {
    const data = parseObjectPayload(payload);
    const slug = parseSlug(data.slug);
    const ch = channel(slug);

    if (!socket.rooms.has(ch)) {
      throw new AppError(
        'Join the room before typing',
        403,
        'NOT_IN_ROOM'
      );
    }

    const room = await Room.findOne({
      slug,
    }).lean();

    if (!room) {
      throw new AppError(
        'Room not found',
        404,
        'ROOM_NOT_FOUND'
      );
    }

    await ensureRoomAccess(room, user.id);

    const result = realtimeState.setTyping(
      slug,
      user.id,
      socket.id,
      true
    );

    if (result.changed) {
      socket.to(ch).emit('typing:update', {
        room: slug,
        userId: user.id,
        isTyping: true,
      });
    }

    return {
      room: slug,
      isTyping: true,
    };
  });

  // --------------------------------------
  // TYPING STOP
  // --------------------------------------

  on('typing:stop', async (payload) => {
    const data = parseObjectPayload(payload);
    const slug = parseSlug(data.slug);
    const ch = channel(slug);

    if (!socket.rooms.has(ch)) {
      throw new AppError(
        'You are not in this room',
        403,
        'NOT_IN_ROOM'
      );
    }

    const result = realtimeState.setTyping(
      slug,
      user.id,
      socket.id,
      false
    );

    if (result.changed) {
      socket.to(ch).emit('typing:update', {
        room: slug,
        userId: user.id,
        isTyping: false,
      });
    }

    return {
      room: slug,
      isTyping: false,
    };
  });

  // --------------------------------------
  // DISCONNECTING
  // --------------------------------------

  socket.on('disconnecting', () => {
    for (const ch of socket.rooms) {
      if (ch.startsWith('room:')) {
        socket.to(ch).emit('room:user_left', {
          room: ch.slice(5),
          user,
        });
      }
    }
  });

  // --------------------------------------
  // DISCONNECT + STATE CLEANUP
  // --------------------------------------

  socket.on('disconnect', (reason) => {
    const result = realtimeState.unregisterSocket(
      socket.id
    );

    if (!result) {
      return;
    }

    // Clear typing notifications.
    for (const typing of result.stoppedTyping) {
      io.to(channel(typing.roomSlug)).emit(
        'typing:update',
        {
          room: typing.roomSlug,
          userId: typing.userId,
          isTyping: false,
        }
      );
    }

    // Only mark offline after the final socket disconnects.
    if (result.isOfflineUser) {
      io.emit('presence:user_offline', {
        userId: result.userId,
        onlineUsers: result.onlineUsers,
      });
    }

    io.emit('presence:count', {
      onlineUsers: result.onlineUsers,
    });

    console.log(
      `[presence] ${user.username} disconnected (${reason})`
    );
  });

  // --------------------------------------
  // SOCKET ERROR
  // --------------------------------------

  socket.on('error', (err) => {
    console.error(
      `[socket] error (${user.username}):`,
      err.message
    );
  });
}