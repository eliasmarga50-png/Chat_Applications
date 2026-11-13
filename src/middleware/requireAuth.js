
import { User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { verifyAccessToken } from '../utils/tokens.js';

const MAX_TOKEN_LENGTH = 4096;
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

export async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const parts = typeof header === 'string' ? header.trim().split(/\s+/) : [];

  if (parts.length !== 2 || !/^bearer$/i.test(parts[0]) || !parts[1]) {
    throw new AppError('Authentication required', 401, 'AUTH_REQUIRED');
  }

  const token = parts[1];
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw new AppError('Token expired', 401, 'TOKEN_EXPIRED');
    }
    throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }

  if (typeof payload.sub !== 'string' || !OBJECT_ID_RE.test(payload.sub)) {
    throw new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }

  const user = await User.findById(payload.sub)
    .select('username displayName role')
    .lean();

  if (!user) throw new AppError('Invalid token', 401, 'INVALID_TOKEN');

  req.user = {
    _id: user._id,
    id: String(user._id),
    username: user.username,
    displayName: user.displayName ?? user.username,
    role: user.role,
  };
  return next();
}
