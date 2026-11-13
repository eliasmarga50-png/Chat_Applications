
import { requireAuth } from './requireAuth.js';

// Public resources remain anonymous when no Authorization header is present.
// A supplied credential is never silently ignored: malformed/invalid JWTs fail.
export async function optionalAuth(req, res, next) {
  if (req.headers.authorization === undefined) return next();
  return requireAuth(req, res, next);
}
