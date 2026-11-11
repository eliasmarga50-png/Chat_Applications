
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import { Upload } from '../models/upload.js';
import {
  UPLOAD_DIR,
  MAX_UPLOAD_BYTES
} from '../config/storage.js';

import { AppError } from '../utils/AppError.js';

const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'text/javascript',
  'application/javascript',
  'text/x-python',
  'text/x-java',
  'text/x-c',
  'text/x-c++',
  'text/x-typescript',
  'text/x-log',
  'application/json'
]);

function sanitizeFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new AppError(
      'A filename is required',
      400,
      'INVALID_FILENAME'
    );
  }

  // Keep only the basename; discard directory traversal paths.
  const basename = path.basename(filename);

  // Remove control characters and path separators.
  const safe = basename
    .replace(/[^\w.\- ()]/g, '_')
    .slice(0, 255);

  if (!safe || safe === '.' || safe === '..') {
    throw new AppError(
      'Invalid filename',
      400,
      'INVALID_FILENAME'
    );
  }

  return safe;
}

function validateMimeType(mimeType) {
  const normalized = String(mimeType || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!ALLOWED_MIME_TYPES.has(normalized)) {
    throw new AppError(
      'Unsupported file type',
      415,
      'UNSUPPORTED_FILE_TYPE'
    );
  }

  return normalized;
}

export async function streamUpload({
  request,
  uploaderId,
  originalName,
  mimeType
}) {
  const safeName = sanitizeFilename(originalName);
  const normalizedMime = validateMimeType(mimeType);

  // Reject oversized requests early when Content-Length exists.
  const declaredLength = Number(request.headers['content-length']);

  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_UPLOAD_BYTES
  ) {
    throw new AppError(
      'Upload exceeds the 100 MB limit',
      413,
      'UPLOAD_TOO_LARGE'
    );
  }

  const storedName = `${randomUUID()}.upload`;
  const destination = path.join(UPLOAD_DIR, storedName);

  const hash = createHash('sha256');
  let totalBytes = 0;

  const meter = new Transform({
    transform(chunk, encoding, callback) {
      totalBytes += chunk.length;

      if (totalBytes > MAX_UPLOAD_BYTES) {
        callback(
          new AppError(
            'Upload exceeds the 100 MB limit',
            413,
            'UPLOAD_TOO_LARGE'
          )
        );
        return;
      }

      hash.update(chunk);

      callback(null, chunk);
    }
  });

  try {
    // The request is consumed progressively.
    // pipeline handles stream errors and backpressure.
    await pipeline(
      request,
      meter,
      createWriteStream(destination, {
        flags: 'wx'
      })
    );

    if (totalBytes === 0) {
      throw new AppError(
        'Empty uploads are not allowed',
        400,
        'EMPTY_UPLOAD'
      );
    }

    // Persist metadata only after the file is complete.
    const upload = await Upload.create({
      uploader: uploaderId,
      originalName: safeName,
      storedName,
      mimeType: normalizedMime,
      size: totalBytes,
      sha256: hash.digest('hex')
    });

    return upload;
  } catch (error) {
    // Avoid orphaned files if streaming or MongoDB fails.
    await unlink(destination).catch(() => {});
    throw error;
  }
}
