import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// crypto.scrypt is CPU-heavy by design. The callback version runs on libuv's
// thread pool, so promisify() gives us await-able hashing that does NOT block
// the event loop (a synchronous scryptSync would freeze every connected socket).
const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;

// Stored format: scrypt$<salt hex>$<key hex>
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;

  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false; // e.g. old placeholder hashes

  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;

  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  // Constant-time comparison: plain === leaks how many leading bytes matched.
  return timingSafeEqual(actual, expected);
}