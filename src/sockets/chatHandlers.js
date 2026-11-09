
import { randomUUID } from 'node:crypto';
import { Room } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { ensureRoomAccess } from '../utils/roomAccess.js';

const SLUG_RE = /^[a-z0-9-]{1,32}$/i;
const MAX_CONTENT = 4000; // matches Message.content maxlength in Step 2
const MAX_ROOMS_PER_SOCKET = 20;
const RATE_MAX = 10;         // messages ...
const RATE_WINDOW_MS = 5_000; // ... per 5 seconds, per socket

// Socket.IO rooms are plain strings. Prefix ours so they can never collide
// with a socket's own auto-created room (its socket.id).
const channel = (slug) => `room:${slug}`;

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

function toClientError(err) {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message };
  }

  console.error('[socket] unexpected handler error:', err);

  return {
    code: 'INTERNAL_ERROR',
    message: 'Something went wrong'
  };
}

// Ensure event payloads are plain object-like values,
// not null, primitives, or arrays.
function parseObjectPayload(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    throw new AppError(
      'Payload must be an object',
      400,
      'INVALID_PAYLOAD'
    );
  }

  return value;
}

// Validate and normalize a room slug.
function parseSlug(value) {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw new AppError(
      'Invalid room slug',
      400,
      'INVALID_ROOM_SLUG'
    );
  }

  return value.toLowerCase();
}

export function registerChatHandlers(io, socket) {
  const user = socket.data.user;

  const allowMessage = createRateLimiter({
    max: RATE_MAX,
    windowMs: RATE_WINDOW_MS
  });

  // Wraps every event handler so that:
  //  - a synchronous throw can't escape the EventEmitter call stack,
  //  - a rejected promise can't become an unhandledRejection,
  //  - the client receives an acknowledgement on success or failure.
  function on(event, handler) {
    socket.on(event, async (...args) => {
      const ack =
        typeof args.at(-1) === 'function'
          ? args.pop()
          : () => {};

      try {
        const result = await handler(args[0]);
        ack({ ok: true, ...result });
      } catch (err) {
        ack({
          ok: false,
          error: toClientError(err)
        });
      }
    });
  }

  // Join a chat room.
  on('room:join', async (payload) => {
    const data = parseObjectPayload(payload);
    const slug = parseSlug(data.slug);

    const room = await Room.findOne({ slug }).lean();

    if (!room) {
      throw new AppError(
        `Room "${slug}" not found`,
        404,
        'ROOM_NOT_FOUND'
      );
    }

    // Private rooms require current membership.
    await ensureRoomAccess(room, user.id);

    const ch = channel(room.slug);

    if (!socket.rooms.has(ch)) {
      // socket.rooms includes the socket's own ID, hence -1.
      if (socket.rooms.size - 1 >= MAX_ROOMS_PER_SOCKET) {
        throw new AppError(
          'Too many rooms joined',
          429,
          'ROOM_LIMIT'
        );
      }

      await socket.join(ch);

      // Notify everyone except the socket that just joined.
      socket.to(ch).emit('room:user_joined', {
        room: room.slug,
        user
      });
    }

    return {
      room: {
        slug: room.slug,
        name: room.name
      }
    };
  });

  // Leave a chat room.
  on('room:leave', async (payload) => {
    const data = parseObjectPayload(payload);
    const slug = parseSlug(data.slug);
    const ch = channel(slug);

    if (socket.rooms.has(ch)) {
      await socket.leave(ch);

      // Notify remaining room members.
      socket.to(ch).emit('room:user_left', {
        room: slug,
        user
      });
    }

    return {
      room: { slug }
    };
  });

  // Send a chat message.
  on('message:send', async (payload) => {
    // 1. Validate the payload structure.
    const data = parseObjectPayload(payload);

    // 2. Validate and normalize the room slug.
    const slug = parseSlug(data.slug);
    const ch = channel(slug);

    // 3. The socket must have joined the room first.
    if (!socket.rooms.has(ch)) {
      throw new AppError(
        'Join the room before sending messages',
        403,
        'NOT_IN_ROOM'
      );
    }

    // 4. Retrieve the current room from MongoDB.
    const room = await Room.findOne({ slug }).lean();

    if (!room) {
      throw new AppError(
        `Room "${slug}" not found`,
        404,
        'ROOM_NOT_FOUND'
      );
    }

    // 5. Recheck current authorization.
    // This catches private-room membership revocation after joining.
    await ensureRoomAccess(room, user.id);

    // 6. Apply the per-socket rate limiter.
    if (!allowMessage()) {
      throw new AppError(
        'You are sending messages too fast',
        429,
        'RATE_LIMITED'
      );
    }

    // 7. Validate and normalize message content.
    const content =
      typeof data.content === 'string'
        ? data.content.trim()
        : '';

    if (content.length < 1 || content.length > MAX_CONTENT) {
      throw new AppError(
        `content must be 1-${MAX_CONTENT} characters`,
        400,
        'INVALID_MESSAGE'
      );
    }

    // 8. Construct the temporary, non-persistent message.
    const message = {
      id: randomUUID(),
      room: slug,
      sender: user,
      content,
      createdAt: new Date().toISOString(),
    };

    // 9. Broadcast to everyone in the room, including the sender.
    io.to(ch).emit('message:new', message);

    // 10. Acknowledge the sender.
    return {
      id: message.id,
      createdAt: message.createdAt
    };
  });

  // Notify other room members when this socket disconnects.
  // 'disconnecting' fires while socket.rooms is still populated.
  socket.on('disconnecting', () => {
    for (const ch of socket.rooms) {
      if (ch.startsWith('room:')) {
        socket.to(ch).emit('room:user_left', {
          room: ch.slice(5),
          user
        });
      }
    }
  });

  // Handle socket-level errors.
  socket.on('error', (err) => {
    console.error(
      `[socket] error (${user.username}):`,
      err.message
    );
  });
}
