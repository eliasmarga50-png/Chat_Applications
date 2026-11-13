
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { Upload } from '../models/upload.js';
import { UPLOAD_DIR } from '../config/storage.js';
import { streamUpload } from '../services/upload.service.js';
import { AppError } from '../utils/AppError.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// Every upload endpoint requires a valid REST JWT.
// requireAuth verifies the token and loads the user from MongoDB.
router.use(requireAuth);

// POST /api/uploads
// Upload a file belonging to the authenticated user.
router.post('/', async (req, res) => {
  const uploaderId = req.user._id;

  const originalName = req.headers['x-file-name'];
  const mimeType = req.headers['content-type'];

  const upload = await streamUpload({
    request: req,
    uploaderId,
    originalName,
    mimeType
  });

  res.status(201).json({
    message: 'Upload completed',
    upload: {
      id: upload._id,
      originalName: upload.originalName,
      mimeType: upload.mimeType,
      size: upload.size,
      sha256: upload.sha256,
      createdAt: upload.createdAt
    }
  });
});

// GET /api/uploads/:id/content
// Only the user who uploaded the file can download it.
router.get('/:id/content', async (req, res) => {
  const uploaderId = req.user._id;

  const upload = await Upload.findOne({
    _id: req.params.id,
    uploader: uploaderId
  }).lean();

  if (!upload) {
    throw new AppError(
      'Upload not found',
      404,
      'UPLOAD_NOT_FOUND'
    );
  }

  const filePath = path.join(
    UPLOAD_DIR,
    upload.storedName
  );

  // Confirm the file still exists.
  await stat(filePath);

  res.setHeader(
    'Content-Type',
    upload.mimeType
  );

  res.setHeader(
    'Content-Length',
    upload.size
  );

  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${upload.originalName.replace(/["\\]/g, '_')}"`
  );

  // Stream the file instead of loading it entirely into memory.
  const fileStream = createReadStream(filePath);

  fileStream.on('error', (error) => {
    console.error(
      '[upload] download stream error:',
      error.message
    );

    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(error);
    }
  });

  fileStream.pipe(res);
});

export default router;
