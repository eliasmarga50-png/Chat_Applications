
import { requireAuth } from './requireAuth.js';

// Authentication is optional for this request.
// If a Bearer token is supplied, it must be valid.
export async function optionalAuth(req, res, next) {
  const authorization = req.headers.authorization;

  // No token: continue as an unauthenticated request.
  if (authorization === undefined) {
    return next();
  }

  // A supplied token must pass the normal authentication checks.
  return requireAuth(req, res, next);
}
