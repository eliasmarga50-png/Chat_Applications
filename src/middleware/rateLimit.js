import { AppError } from '../utils/AppError.js';

// Fixed-window, in-memory limiter keyed per authenticated user.
// Like realtimeState, this lives in one process: use a shared store (Redis)
// if the server is ever scaled horizontally.
export function rateLimit({ windowMs, max, code = 'RATE_LIMITED', message = 'Too many requests' }) {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  sweep.unref(); // never keep the process alive just for cleanup

  return (req, res, next) => {
    const key = req.user?.id ?? req.ip;
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    if (++entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      throw new AppError(message, 429, code);
    }
    next();
  };
}