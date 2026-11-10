
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);

// Resolve storage relative to the project, not the shell's working directory.
export const UPLOAD_DIR = path.resolve(
  currentDirectory,
  '../../uploads'
);

// Maximum upload size: 100 MB.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Prepare the storage directory before accepting uploads.
export async function initializeStorage() {
  await fs.mkdir(UPLOAD_DIR, {
    recursive: true
  });

  console.log(`[storage] directory ready: ${UPLOAD_DIR}`);
}
