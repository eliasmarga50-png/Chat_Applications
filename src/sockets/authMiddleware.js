import { User } from '../models/index.js';
import { verifyAccessToken } from '../utils/tokens.js';

const MAX_TOKEN_LENGTH = 4096;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const MAX_TIMEOUT_MS = 2 ** 31 - 1; // setTimeout overflows (fires instantly) above this

// Errors passed to next() reach the client as `connect_error`, with err.data.code.
function reject(message, code) {
  const err = new Error(message);
  err.data = { code };
  return err;
}

// 1. Authorization: Bearer <jwt>   (non-browser clients, proxies, tests)
// 2. handshake.auth.token          (browsers cannot set headers on a WebSocket)
// Never the query string: URLs end up in access logs and browser history.
export function extractToken(socket) {
  const header = socket.handshake.headers.authorization; // Node lower-cases header names
  if (typeof header === 'string') {
    const [scheme, token] = header.trim().split(/\s+/);
    if (/^bearer$/i.test(scheme) && token) return token;
  }
  const fromAuth = socket.handshake.auth?.token;
  return typeof fromAuth === 'string' && fromAuth ? fromAuth : null;
}

export async function authenticate(socket, next) {
  try {
    const token = extractToken(socket);
    if (!token) return next(reject('Authentication token required', 'AUTH_REQUIRED'));
    if (token.length > MAX_TOKEN_LENGTH) return next(reject('Invalid token', 'INVALID_TOKEN'));

    // Layer 1: cryptographic check (signature, exp, iss, aud, algorithm). No I/O.
    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return next(reject('Token expired', 'TOKEN_EXPIRED'));
      }
      return next(reject('Invalid token', 'INVALID_TOKEN'));
    }

    if (typeof payload.sub !== 'string' || !OBJECT_ID_RE.test(payload.sub)) {
      return next(reject('Invalid token', 'INVALID_TOKEN'));
    }

    // Layer 2: a valid signature only proves WE issued this token at some point.
    // The account may have been deleted since, so cross-check MongoDB.
    const user = await User.findById(payload.sub).select('username displayName role').lean();
    if (!user) return next(reject('Invalid token', 'INVALID_TOKEN')); // same message: don't reveal why

    // Attach a public projection, not the raw document: Step 3 broadcasts this
    // object to other users, so it must never carry email or hashes.
    socket.data.user = {
      id: String(user._id),
      username: user.username,
      displayName: user.displayName ?? user.username,
      role: user.role,
    };
    socket.data.tokenExp = payload.exp; // seconds since epoch
    next();
  } catch (err) {
    // DB down, driver error, anything unexpected: reject THIS handshake only.
    console.error('[socket] auth failed unexpectedly:', err.message);
    next(reject('Authentication temporarily unavailable', 'AUTH_UNAVAILABLE'));
  }
}

// The JWT is only checked at handshake time, but a WebSocket can live for days.
// Without this, a token that expired an hour ago would still be "logged in".
export function scheduleSessionExpiry(socket) {
  let timer;

  const expire = () => {
    socket.emit('auth:expired', { code: 'TOKEN_EXPIRED', message: 'Session expired, please log in again' });
    socket.disconnect(true); // engine.io flushes the pending emit before closing
  };

  const arm = () => {
    const msLeft = socket.data.tokenExp * 1000 - Date.now();
    if (msLeft <= 0) return expire();
    timer = setTimeout(arm, Math.min(msLeft, MAX_TIMEOUT_MS)); // re-arms if clamped
  };

  arm();
  socket.once('disconnect', () => clearTimeout(timer)); // no leaked timers
}