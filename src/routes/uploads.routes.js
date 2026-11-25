
import { Router } from "express";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";

import { Upload } from "../models/upload.js";
import { UPLOAD_DIR } from "../config/storage.js";
import {
  streamUpload,
  assertUploadFileExists,
} from "../services/upload.service.js";
import { AppError } from "../utils/AppError.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

router.use(requireAuth);

// GET /api/uploads
// Return only the authenticated user's upload history.
router.get("/", async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const requestedLimit = Number(req.query.limit ?? 10);

  if (!Number.isInteger(page) || page < 1) {
    throw new AppError(
      "Page must be a positive integer",
      400,
      "INVALID_PAGE"
    );
  }

  if (
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1
  ) {
    throw new AppError(
      "Limit must be a positive integer",
      400,
      "INVALID_LIMIT"
    );
  }

  const limit = Math.min(requestedLimit, 50);
  const skip = (page - 1) * limit;

  const filter = {
    uploader: req.user._id,
  };

  const [uploads, total] = await Promise.all([
    Upload.find(filter)
      .select(
        "originalName mimeType size sha256 createdAt"
      )
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    Upload.countDocuments(filter),
  ]);

  res.status(200).json({
    uploads: uploads.map((upload) => ({
      id: String(upload._id),
      originalName: upload.originalName,
      mimeType: upload.mimeType,
      size: upload.size,
      sha256: upload.sha256,
      createdAt: upload.createdAt,
    })),

    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// POST /api/uploads
// Receive the original raw file bytes.
router.post("/", async (req, res) => {
  const upload = await streamUpload({
    request: req,
    uploaderId: req.user._id,
    originalName: req.headers["x-file-name"],
    mimeType: req.headers["content-type"],
  });

  res.status(201).json({
    message: "Upload completed",
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

// GET /api/uploads/:id/content
// Download an upload owned by the authenticated user.
router.get("/:id/content", async (req, res) => {
  const upload = await Upload.findOne({
    _id: req.params.id,
    uploader: req.user._id,
  }).lean();

  if (!upload) {
    throw new AppError(
      "Upload not found",
      404,
      "UPLOAD_NOT_FOUND"
    );
  }

  const filePath = path.join(
    UPLOAD_DIR,
    upload.storedName
  );

  await assertUploadFileExists(filePath);

  const safeDownloadName = upload.originalName.replace(
    /["\\\r\n]/g,
    "_"
  );

  res.setHeader("Content-Type", upload.mimeType);
  res.setHeader("Content-Length", upload.size);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeDownloadName}"`
  );

  try {
    await pipeline(createReadStream(filePath), res);
  } catch (error) {
    if (
      !res.headersSent &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      res.removeHeader("Content-Type");
      res.removeHeader("Content-Length");
      res.removeHeader("Content-Disposition");

      throw new AppError(
        "Uploaded file is no longer available",
        404,
        "UPLOAD_FILE_NOT_FOUND"
      );
    }

    if (res.headersSent) {
      res.destroy(error);
    } else {
      res.removeHeader("Content-Type");
      res.removeHeader("Content-Length");
      res.removeHeader("Content-Disposition");
      throw error;
    }
  }
});

// DELETE /api/uploads/:id
// Delete an upload owned by the authenticated user.
router.delete("/:id", async (req, res) => {
  const upload = await Upload.findOne({
    _id: req.params.id,
    uploader: req.user._id,
  }).lean();

  if (!upload) {
    throw new AppError(
      "Upload not found",
      404,
      "UPLOAD_NOT_FOUND"
    );
  }

  const filePath = path.join(
    UPLOAD_DIR,
    upload.storedName
  );

  // Remove the physical file. A missing file does not
  // prevent removal of its database metadata.
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await Upload.deleteOne({
    _id: upload._id,
    uploader: req.user._id,
  });

  res.status(200).json({
    message: "Upload deleted successfully",
    deletedUpload: {
      id: String(upload._id),
      originalName: upload.originalName,
    },
  });
});

export default router;
