import { AppError } from './AppError.js';

export const MAX_MESSAGE_CONTENT = 4000;

const SLUG_RE = /^[a-z0-9-]{1,32}$/i;

const ALLOWED_MESSAGE_FIELDS = new Set([
  'slug',
  'content',
]);

export function validateMessagePayload(payload) {
  // Require a plain JSON-like object.
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    (
      Object.getPrototypeOf(payload) !== Object.prototype &&
      Object.getPrototypeOf(payload) !== null
    )
  ) {
    throw new AppError(
      'Message payload must be a plain object',
      400,
      'INVALID_PAYLOAD'
    );
  }

  // Reject unexpected fields.
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_MESSAGE_FIELDS.has(key)) {
      throw new AppError(
        `Unexpected message field: ${key}`,
        400,
        'INVALID_PAYLOAD'
      );
    }
  }

  const { slug, content } = payload;

  if (
    typeof slug !== 'string' ||
    !SLUG_RE.test(slug)
  ) {
    throw new AppError(
      'Invalid room slug',
      400,
      'INVALID_ROOM_SLUG'
    );
  }

  if (typeof content !== 'string') {
    throw new AppError(
      'Message content must be a string',
      400,
      'INVALID_MESSAGE'
    );
  }

  if (
    content.trim().length === 0 ||
    content.length > MAX_MESSAGE_CONTENT
  ) {
    throw new AppError(
      `Message content must contain 1-${MAX_MESSAGE_CONTENT} characters`,
      400,
      'INVALID_MESSAGE'
    );
  }

  // Do not trim content because whitespace matters
  // in Markdown and developer code.
  return {
    slug: slug.toLowerCase(),
    content,
  };
}