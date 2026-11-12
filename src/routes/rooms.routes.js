import { Router } from 'express';

import { Room, Message } from '../models/index.js';

import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';
import { ensureRoomAccess } from '../utils/roomAccess.js';

import { sanitizeContent } from '../utils/sanitizeContent.js';

const router = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// ----------------------------------------
// ROOM VALIDATION
// ----------------------------------------

async function findRoomOr404(slug) {
  if (
    typeof slug !== 'string' ||
    !/^[a-z0-9-]{1,32}$/i.test(slug)
  ) {
    throw new AppError(
      'Invalid room slug',
      400,
      'INVALID_ROOM_SLUG'
    );
  }

  const normalizedSlug = slug.toLowerCase();

  const room = await Room.findOne({
    slug: normalizedSlug,
  }).lean();

  if (!room) {
    throw new AppError(
      `Room "${normalizedSlug}" not found`,
      404,
      'ROOM_NOT_FOUND'
    );
  }

  return room;
}

// ----------------------------------------
// PAGINATION VALIDATION
// ----------------------------------------

function parseLimit(rawLimit) {
  if (rawLimit === undefined) {
    return DEFAULT_LIMIT;
  }

  if (
    typeof rawLimit !== 'string' ||
    !/^\d+$/.test(rawLimit)
  ) {
    throw new AppError(
      'limit must be a positive integer',
      400,
      'INVALID_LIMIT'
    );
  }

  const limit = Number(rawLimit);

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT
  ) {
    throw new AppError(
      `limit must be between 1 and ${MAX_LIMIT}`,
      400,
      'INVALID_LIMIT'
    );
  }

  return limit;
}

// ----------------------------------------
// CURSOR VALIDATION
// ----------------------------------------

function parseCursorDate(rawDate) {
  if (
    typeof rawDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(rawDate)
  ) {
    throw new AppError(
      '"before" must be a valid ISO date in UTC',
      400,
      'INVALID_CURSOR'
    );
  }

  const date = new Date(rawDate);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString() !== rawDate
  ) {
    throw new AppError(
      '"before" must be a valid ISO date in UTC',
      400,
      'INVALID_CURSOR'
    );
  }

  return date;
}

function parseCursorId(rawId) {
  if (
    typeof rawId !== 'string' ||
    !/^[a-f\d]{24}$/i.test(rawId)
  ) {
    throw new AppError(
      '"beforeId" must be a valid MongoDB ObjectId',
      400,
      'INVALID_CURSOR'
    );
  }

  return rawId;
}

// ----------------------------------------
// GET /api/rooms
// ----------------------------------------

router.get('/', async (req, res) => {
  const rooms = await Room.find({
    isPrivate: false,
  })
    .sort({
      name: 1,
    })
    .lean();

  res.json({
    count: rooms.length,
    rooms,
  });
});

// ----------------------------------------
// DEVELOPMENT ERROR TEST
// ----------------------------------------

if (!env.isProd) {
  router.get('/__debug/boom', async () => {
    await Promise.resolve();

    throw new Error(
      'Simulated async failure'
    );
  });
}

// ----------------------------------------
// GET /api/rooms/:slug
// ----------------------------------------

router.get('/:slug', async (req, res) => {
  const room = await findRoomOr404(
    req.params.slug
  );

  await ensureRoomAccess(
    room,
    req.user?._id
  );

  res.json(room);
});

// ----------------------------------------
// GET ROOM MESSAGES
// ----------------------------------------

router.get('/:slug/messages', async (req, res) => {
  const room = await findRoomOr404(
    req.params.slug
  );

  // 1. Verify room access.
  await ensureRoomAccess(
    room,
    req.user?._id
  );

  // 2. Validate pagination limit.
  const limit = parseLimit(req.query.limit);

  const filter = {
    room: room._id,
  };

  // 3. Validate cursor parameters.
  const hasBefore =
    req.query.before !== undefined;

  const hasBeforeId =
    req.query.beforeId !== undefined;

  if (hasBefore !== hasBeforeId) {
    throw new AppError(
      'Both "before" and "beforeId" are required for pagination',
      400,
      'INVALID_CURSOR'
    );
  }

  if (hasBefore && hasBeforeId) {
    const before = parseCursorDate(
      req.query.before
    );

    const beforeId = parseCursorId(
      req.query.beforeId
    );

    filter.$or = [
      {
        createdAt: {
          $lt: before,
        },
      },
      {
        createdAt: before,
        _id: {
          $lt: beforeId,
        },
      },
    ];
  }

  // 4. Retrieve messages.
  const docs = await Message.find(filter)
    .sort({
      createdAt: -1,
      _id: -1,
    })
    .limit(limit + 1)
    .populate(
      'sender',
      'username displayName avatarUrl'
    )
    .lean();

  const hasMore = docs.length > limit;

  // 5. Remove extra pagination document.
  const messages = hasMore
    ? docs.slice(0, limit)
    : docs;

  // 6. Sanitize historical message content.
  // This does not change existing MongoDB records.
  for (const message of messages) {
    if (typeof message.content === 'string') {
      message.content = sanitizeContent(
        message.content
      );
    }
  }

  // 7. Generate next cursor.
  const lastMessage = messages.at(-1);

  // 8. Return safe message history.
  res.json({
    room: {
      slug: room.slug,
      name: room.name,
    },

    count: messages.length,

    hasMore,

    nextCursor: hasMore
      ? {
          createdAt: lastMessage.createdAt,
          _id: lastMessage._id,
        }
      : null,

    messages,
  });
});

export default router;