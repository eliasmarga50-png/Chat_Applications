import { Router } from 'express';
import { User } from '../models/index.js';
import { AppError } from '../utils/AppError.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { signAccessToken } from '../utils/tokens.js';
import { env } from '../config/env.js';

const router = Router();

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128; // cap input size: scrypt cost grows with it (DoS guard)

// Compared against when the username doesn't exist, so "unknown user" and
// "wrong password" take about the same time and can't be told apart by timing.
let dummyHash;
const getDummyHash = () => (dummyHash ??= hashPassword('timing-equalizer'));

function requireStrings(body, fields) {
  for (const field of fields) {
    // typeof check also blocks NoSQL operator injection like { "$ne": null }
    if (typeof body[field] !== 'string' || body[field].length === 0) {
      throw new AppError(`${field} must be a non-empty string`, 400, 'VALIDATION_ERROR');
    }
  }
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const body = req.body ?? {};
  requireStrings(body, ['username', 'email', 'password']);

  if (body.password.length < MIN_PASSWORD || body.password.length > MAX_PASSWORD) {
    throw new AppError(
      `password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters`,
      400,
      'VALIDATION_ERROR'
    );
  }

  // Username/email format rules live in the User schema; a violation becomes a
  // 400 via errorHandler, and a duplicate becomes a 409.
  const user = await User.create({
    username: body.username,
    email: body.email,
    displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    passwordHash: await hashPassword(body.password),
  });

  res.status(201).json({ user: user.toJSON(), token: signAccessToken(user), expiresIn: env.JWT_EXPIRES_IN });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const body = req.body ?? {};
  requireStrings(body, ['username', 'password']);

  const user = await User.findOne({ username: body.username.trim().toLowerCase() })
    .select('+passwordHash'); // passwordHash is select:false by default

  const passwordOk = body.password.length <= MAX_PASSWORD
    && await verifyPassword(body.password, user?.passwordHash ?? await getDummyHash());

  if (!user || !passwordOk) {
    throw new AppError('Invalid username or password', 401, 'INVALID_CREDENTIALS');
  }

  res.json({ user: user.toJSON(), token: signAccessToken(user), expiresIn: env.JWT_EXPIRES_IN });
});

export default router;