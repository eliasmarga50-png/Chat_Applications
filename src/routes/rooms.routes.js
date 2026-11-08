import { Router } from 'express';
import { Room, Message } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

const router = Router();

async function findRoomOr404(slug) {
  const room = await Room.findOne({ slug: slug.toLowerCase() }).lean();
  if (!room) throw new AppError(`Room "${slug}" not found`, 404, 'ROOM_NOT_FOUND');
  return room;
}

// GET /api/rooms  -> public rooms, A-Z (served by the {isPrivate, name} index)
router.get('/', async (req, res) => {
  const rooms = await Room.find({ isPrivate: false }).sort({ name: 1 }).lean();
  res.json({ count: rooms.length, rooms });
});

// GET /api/rooms/:slug
router.get('/:slug', async (req, res) => {
  res.json(await findRoomOr404(req.params.slug));
});

// GET /api/rooms/:slug/messages?limit=20&before=<ISO date>
// Cursor pagination: stable under concurrent inserts and O(limit) via the
// {room, createdAt} index, unlike skip(), which scans and discards.
router.get('/:slug/messages', async (req, res) => {
  const room = await findRoomOr404(req.params.slug);

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const filter = { room: room._id };

  if (req.query.before) {
    const before = new Date(req.query.before);
    if (Number.isNaN(before.getTime())) {
      throw new AppError('"before" must be a valid ISO date', 400, 'INVALID_CURSOR');
    }
    filter.createdAt = { $lt: before };
  }

  // Fetch limit+1 to learn whether another page exists without a count query.
  const docs = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit + 1)
    .populate('sender', 'username displayName avatarUrl') // 2nd batched query
    .lean();

  const hasMore = docs.length > limit;
  const messages = hasMore ? docs.slice(0, limit) : docs;

  res.json({
    room: { slug: room.slug, name: room.name },
    count: messages.length,
    hasMore,
    nextBefore: hasMore ? messages.at(-1).createdAt : null,
    messages, // newest first; the client reverses for display
  });
});

// Dev-only: proves async errors reach the error middleware without crashing.
if (!env.isProd) {
  router.get('/__debug/boom', async () => {
    await Promise.resolve();
    throw new Error('Simulated async failure');
  });
}

export default router;