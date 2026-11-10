import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const ISSUER = 'devconnect';
export const AUDIENCE = 'devconnect-chat';

// Only the user id (sub) and username travel in the token. Role, existence and
// everything else are re-read from MongoDB on every handshake, so a token can
// never claim privileges the database doesn't grant.
export function signAccessToken(user) {
  return jwt.sign({ username: user.username }, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(user._id),
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

// Throws TokenExpiredError / JsonWebTokenError on any problem.
// Pinning `algorithms` blocks "alg: none" and algorithm-confusion attacks.
export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}