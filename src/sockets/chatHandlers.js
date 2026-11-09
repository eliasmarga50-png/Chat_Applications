import { randomUUID } from 'node:crypto';
import { Room } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { ensureRoomAccess } from '../utils/roomAccess.js';

const SLUG_RE = /^[a-z0-9-]{1,32}$/i;
const MAX_CONTENT = 4000; // matches Message.content maxlength in Step 2
const MAX_ROOMS_PER_SOCKET = 20;
const RATE_MAX = 10;        // messages ...
const RATE_WINDOW_MS = 5_000; // ... per 5 seconds, per socket

// Socket.io rooms are plain strings. Prefix ours so they can never collide
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
  if (err instanceof AppError) return { code: err.code, message: err.message };
  console.error('[socket] unexpected handler error:', err);
  return { code: 'INTERNAL_ERROR', message: 'Something went wrong' };
}

function parseSlug(value) {
  if (typeof value !== 'string' || !SLUG_RE.test(value)) {
    throw new AppError('Invalid room slug', 400, 'INVALID_ROOM_SLUG');
  }
  return value.toLowerCase();
}

export function registerChatHandlers(io, socket) {
  const user = socket.data.user;
  const allowMessage = createRateLimiter({ max: RATE_MAX, windowMs: RATE_WINDOW_MS });

  // Wraps every event handler so that:
  //  - a synchronous throw can't escape the EventEmitter call stack,
  //  - a rejected promise can't become an unhandledRejection (which our
  //    server.js treats as fatal),
  //  - the client always receives an acknowledgement, success or failure.
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
    const slug = parseSlug(payload?.slug);

    const room = await Room.findOne({ slug }).lean();
    if (!room) throw new AppError(`Room "${slug}" not found`, 404, 'ROOM_NOT_FOUND');

    // Same rule as the REST layer: private rooms require membership.
    await ensureRoomAccess(room, user.id);

    const ch = channel(room.slug);
    if (!socket.rooms.has(ch)) {
      // socket.rooms always contains the socket's own id, hence the -1.
      if (socket.rooms.size - 1 >= MAX_ROOMS_PER_SOCKET) {
        throw new AppError('Too many rooms joined', 429, 'ROOM_LIMIT');
      }
      await socket.join(ch);
      // socket.to(...) = everyone in the room EXCEPT this socket.
      socket.to(ch).emit('room:user_joined', { room: room.slug, user });
    }

    return { room: { slug: room.slug, name: room.name } };
  });

  on('room:leave', async (payload) => {
    const slug = parseSlug(payload?.slug);
    const ch = channel(slug);

    if (socket.rooms.has(ch)) {
      await socket.leave(ch);
      socket.to(ch).emit('room:user_left', { room: slug, user });
    }
    return { room: { slug } };
  });

  on('message:send', async (payload) => {
    const slug = parseSlug(payload?.slug);
    const ch = channel(slug);

    // Authorization is "are you in the room?" — membership was checked at join time.
    if (!socket.rooms.has(ch)) {
      throw new AppError('Join the room before sending messages', 403, 'NOT_IN_ROOM');
    }
    if (!allowMessage()) {
      throw new AppError('You are sending messages too fast', 429, 'RATE_LIMITED');
    }

    const content = typeof payload.content === 'string' ? payload.content.trim() : '';
    if (content.length < 1 || content.length > MAX_CONTENT) {
      throw new AppError(
        `content must be 1-${MAX_CONTENT} characters`,
        400,
        'INVALID_MESSAGE'
      );
    }

    // Step 3 broadcasts only. Persisting to MongoDB arrives in Step 6, and
    // sanitisation in Step 7, so `content` is NOT yet safe to render as HTML.
    const message = {
      id: randomUUID(),
      room: slug,
      sender: user,
      content,
      createdAt: new Date().toISOString(),
    };

    io.to(ch).emit('message:new', message); // everyone in the room, sender included
    return { id: message.id, createdAt: message.createdAt };
  });

  // 'disconnecting' fires while socket.rooms is still populated;
  // by the time 'disconnect' fires, the socket has already left every room.
  socket.on('disconnecting', () => {
    for (const ch of socket.rooms) {
      if (ch.startsWith('room:')) {
        socket.to(ch).emit('room:user_left', { room: ch.slice(5), user });
      }
    }
  });

  // A listener-less 'error' event on an EventEmitter throws, so always attach one.
  socket.on('error', (err) => {
    console.error(`[socket] error (${user.username}):`, err.message);
  });
}