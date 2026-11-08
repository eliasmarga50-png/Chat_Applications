import { env } from '../config/env.js';

function normalize(err) {
  // Malformed JSON body (thrown by express.json())
  if (err.type === 'entity.parse.failed') {
    return { statusCode: 400, code: 'INVALID_JSON', message: 'Request body is not valid JSON' };
  }
  // Mongoose: bad ObjectId, e.g. /api/users/not-an-id
  if (err.name === 'CastError') {
    return { statusCode: 400, code: 'INVALID_ID', message: `Invalid ${err.path}: ${err.value}` };
  }
  // Mongoose: schema validation failed
  if (err.name === 'ValidationError') {
    const details = Object.values(err.errors).map((e) => e.message);
    return { statusCode: 400, code: 'VALIDATION_ERROR', message: details.join('; ') };
  }
  // MongoDB duplicate key (unique index)
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'field';
    return { statusCode: 409, code: 'DUPLICATE_KEY', message: `Duplicate value for ${field}` };
  }
  // Mongo is unreachable / server selection timed out
  if (err.name === 'MongoServerSelectionError' || err.name === 'MongoNetworkError') {
    return { statusCode: 503, code: 'DB_UNAVAILABLE', message: 'Database temporarily unavailable' };
  }
  if (err.isOperational) {
    return { statusCode: err.statusCode, code: err.code, message: err.message };
  }
  // Unknown = a bug. Never leak internals to the client.
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong' };
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const { statusCode, code, message } = normalize(err);

  if (statusCode >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);

  // If headers were already sent, delegate to Express's default handler,
  // which closes the connection safely.
  if (res.headersSent) return next(err);

  res.status(statusCode).json({
    error: { code, message, ...(env.isProd ? {} : { stack: err.stack }) },
  });
}