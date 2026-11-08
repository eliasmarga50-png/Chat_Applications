import { Router } from 'express';
import { rooms } from '../data/rooms.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

const router = Router();

router.get('/', async (req, res) => {
  res.json({ count: rooms.length, rooms });
});

router.get('/:slug', async (req, res) => {
  const room = rooms.find((r) => r.slug === req.params.slug.toLowerCase());
  if (!room) throw new AppError(`Room "${req.params.slug}" not found`, 404, 'ROOM_NOT_FOUND');
  res.json(room);
});

// Dev-only: proves async errors reach the error middleware without crashing.
if (!env.isProd) {
  router.get('/__debug/boom', async () => {
    await Promise.resolve();
    throw new Error('Simulated async failure');
  });
}

export default router;