import { Router } from 'express';
import mongoose from 'mongoose';

const router = Router();

const STATES = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };

router.get('/', async (req, res) => {
  const readyState = mongoose.connection.readyState;
  let pingMs = null;

  if (readyState === 1) {
    const start = performance.now();
    // Real network round-trip: the await yields to the event loop while Mongo answers.
    await mongoose.connection.db.admin().ping();
    pingMs = Math.round(performance.now() - start);
  }

  const healthy = readyState === 1;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    db: { state: STATES[readyState], pingMs },
    timestamp: new Date().toISOString(),
  });
});

export default router;