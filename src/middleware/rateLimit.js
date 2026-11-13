
import { AppError } from '../utils/AppError.js';
import { getRedisClient } from '../config/redis.js';

const CONSUME_FIXED_WINDOW = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  local ttl = redis.call('PTTL', KEYS[1])
  return { count, ttl }
`;

export async function consumeRateLimitWithClient(client, { key, windowMs, max }) {
  const result = await client.eval(CONSUME_FIXED_WINDOW, {
    keys: [`devchat:rate:${key}`],
    arguments: [String(windowMs)],
  });

  return {
    allowed: Number(result[0]) <= max,
    count: Number(result[0]),
    retryAfterMs: Math.max(0, Number(result[1])),
  };
}

export async function consumeRateLimit({ key, windowMs, max }) {
  try {
    return await consumeRateLimitWithClient(getRedisClient(), { key, windowMs, max });
  } catch (error) {
    console.error('[rate-limit] Redis operation failed:', error.message);
    throw new AppError('Rate limiting service unavailable', 503, 'RATE_LIMIT_UNAVAILABLE');
  }
}

export function rateLimit({
  windowMs,
  max,
  code = 'RATE_LIMITED',
  message = 'Too many requests',
}) {
  if (!Number.isInteger(windowMs) || windowMs < 1 || !Number.isInteger(max) || max < 1) {
    throw new TypeError('rateLimit requires positive integer windowMs and max');
  }

  return async (req, res, next) => {
    try {
      const identity = req.user?.id ?? req.ip ?? req.socket.remoteAddress ?? 'unknown';
      const result = await consumeRateLimit({
        key: `rest:${req.baseUrl || ''}:${identity}`,
        windowMs,
        max,
      });

      if (!result.allowed) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        throw new AppError(message, 429, code);
      }

      return next();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Rate limiting service unavailable', 503, 'RATE_LIMIT_UNAVAILABLE');
    }
  };
}
