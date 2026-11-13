
import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

import { Upload } from '../models/upload.js';
import { UPLOAD_DIR } from '../config/storage.js';
import { streamUpload, assertUploadFileExists } from '../services/upload.service.js';
import { AppError } from '../utils/AppError.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  const upload = await streamUpload({
    request: req,
    uploaderId: req.user._id,
    originalName: req.headers['x-file-name'],
    mimeType: req.headers['content-type'],
  });

  res.status(201).json({
    message: 'Upload completed',
    upload: {
      id: upload._id,
      originalName: upload.originalName,
      mimeType: upload.mimeType,
      size: upload.size,
      sha256: upload.sha256,
      createdAt: upload.createdAt,
    },
  });
});

router.get('/:id/content', async (req, res) => {
  const upload = await Upload.findOne({
    _id: req.params.id,
    uploader: req.user._id,
  }).lean();

  if (!upload) throw new AppError('Upload not found', 404, 'UPLOAD_NOT_FOUND');

  const filePath = path.join(UPLOAD_DIR, upload.storedName);
  await assertUploadFileExists(filePath);

  const safeDownloadName = upload.originalName.replace(/["\\\r\n]/g, '_');
  res.setHeader('Content-Type', upload.mimeType);
  res.setHeader('Content-Length', upload.size);
  res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName}"`);

  try {
    await pipeline(createReadStream(filePath), res);
  } catch (error) {
    if (!res.headersSent && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Disposition');
      throw new AppError('Uploaded file is no longer available', 404, 'UPLOAD_FILE_NOT_FOUND');
    }
    if (res.headersSent) res.destroy(error);
    else {
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Disposition');
      throw error;
    }
  }
});

export default router;
