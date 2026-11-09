import { env } from '../config/env.js';
import { User } from '../models/index.js';

// TEMPORARY (Step 3 only). Step 4 replaces this file with real JWT validation.
// It exists because rooms/messages need to know *who* is connected, and we
// have no login flow yet. It trusts a username, so it refuses to run in production.

const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

function reject(message, code) {
  const err = new Error(message);
  err.data = { code }; // delivered to the client as connect_error.data
  return err;
}

export async function devIdentity(socket, next) {
  try {
    if (env.isProd) {
      return next(reject('Authentication is not configured', 'AUTH_NOT_CONFIGURED'));
    }

    const raw = socket.handshake.auth?.username;
    const username = typeof raw === 'string' ? raw.toLowerCase() : '';

    if (!USERNAME_RE.test(username)) {
      return next(reject('auth.username is required', 'AUTH_REQUIRED'));
    }

    const user = await User.findOne({ username }).select('username displayName').lean();
    if (!user) {
      return next(reject('Unknown user', 'AUTH_FAILED'));
    }

    // socket.data is the supported place for per-connection state.
    socket.data.user = {
      id: user._id.toString(),
      username: user.username,
      displayName: user.displayName ?? user.username,
    };
    next();
  } catch (err) {
    // A DB hiccup must reject this one handshake, never crash the process.
    console.error('[socket] identity lookup failed:', err.message);
    next(reject('Authentication temporarily unavailable', 'AUTH_UNAVAILABLE'));
  }
}