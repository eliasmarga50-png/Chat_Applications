import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_PASSWORD_BYTES = 1024;

export async function hashPassword(password) {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') === 0 ||
    Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
  ) {
    throw new TypeError('Password must be a non-empty string of at most 1024 bytes');
  }

  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH);

  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') === 0 ||
    Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES ||
    typeof stored !== 'string'
  ) {
    return false;
  }

  const parts = stored.split('$');

  if (parts.length !== 3) return false;

  const [scheme, saltHex, keyHex] = parts;

  if (
    scheme !== 'scrypt' ||
    !/^[a-f0-9]{32}$/i.test(saltHex) ||
    !/^[a-f0-9]{128}$/i.test(keyHex)
  ) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');

  const actual = await scryptAsync(password, salt, KEY_LENGTH);

  return timingSafeEqual(actual, expected);
}