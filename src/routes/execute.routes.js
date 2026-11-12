import { Router } from 'express';

import { requireAuth } from '../middleware/requireAuth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { runSnippet } from '../services/codeExecution.service.js';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

const router = Router();

const limiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  code: 'RATE_LIMITED',
  message: 'Too many executions, slow down',
});

// POST /api/execute
// Body: { "code": "console.log(1 + 1)" }
// Always 200 when the snippet was run (even if it threw or timed out):
// the outcome is in `status`. 4xx/5xx mean it was never run.
router.post('/', requireAuth, limiter, async (req, res) => {
  const body = req.body;

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('Body must be a JSON object', 400, 'VALIDATION_ERROR');
  }
  if (body.language !== undefined && body.language !== 'javascript') {
    throw new AppError('Only "javascript" is supported', 400, 'UNSUPPORTED_LANGUAGE');
  }
  if (typeof body.code !== 'string' || body.code.trim().length === 0) {
    throw new AppError('code must be a non-empty string', 400, 'VALIDATION_ERROR');
  }
  if (body.code.length > env.EXEC_MAX_CODE_CHARS) {
    throw new AppError(
      `code must be at most ${env.EXEC_MAX_CODE_CHARS} characters`,
      413,
      'CODE_TOO_LARGE'
    );
  }

  const result = await runSnippet(body.code, { ownerId: req.user.id });
  res.json(result);
});

export default router;