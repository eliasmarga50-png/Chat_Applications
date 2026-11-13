
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { Upload } from '../src/models/upload.js';
import { initializeStorage, UPLOAD_DIR } from '../src/config/storage.js';
import { streamUpload, assertUploadFileExists } from '../src/services/upload.service.js';

async function runRawUpload(mimeType, filename, contents) {
  await initializeStorage();
  const originalCreate = Upload.create;
  Upload.create = async (document) => ({ _id: 'upload-id', ...document });
  const request = new PassThrough();
  request.headers = { 'content-length': String(Buffer.byteLength(contents)) };
  const pending = streamUpload({
    request,
    uploaderId: '64b000000000000000000001',
    originalName: filename,
    mimeType,
  });
  request.end(contents);
  try {
    const upload = await pending;
    const filePath = path.join(UPLOAD_DIR, upload.storedName);
    assert.equal(await readFile(filePath, 'utf8'), contents);
    await rm(filePath, { force: true });
    return upload;
  } finally {
    Upload.create = originalCreate;
  }
}

test('raw application/json upload is streamed without JSON parsing', async () => {
  const body = JSON.stringify({ source: 'const answer = 42;' });
  const upload = await runRawUpload('application/json', 'snippet.json', body);
  assert.equal(upload.mimeType, 'application/json');
  assert.equal(upload.size, Buffer.byteLength(body));
  assert.equal(upload.sha256.length, 64);
});

test('supported non-JSON source uploads are streamed', async () => {
  const body = 'console.log("hello");\n';
  const upload = await runRawUpload('application/javascript; charset=utf-8', 'hello.js', body);
  assert.equal(upload.mimeType, 'application/javascript');
  assert.equal(upload.size, Buffer.byteLength(body));
});

test('missing physical upload maps to a structured 404', async () => {
  await assert.rejects(
    assertUploadFileExists(path.join(UPLOAD_DIR, 'definitely-missing-upload-file')),
    { statusCode: 404, code: 'UPLOAD_FILE_NOT_FOUND' },
  );
});

test('authenticated JSON upload reaches the raw streaming route', async () => {
  const { createServer } = await import('node:http');
  const { createApp } = await import('../src/app.js');
  const { User } = await import('../src/models/index.js');
  const { signAccessToken } = await import('../src/utils/tokens.js');

  const originalUserFindById = User.findById;
  const originalUploadCreate = Upload.create;
  const userId = '64b000000000000000000001';
  let createdDocument;

  User.findById = () => ({
    select: () => ({
      lean: async () => ({ _id: userId, username: 'developer', displayName: 'Developer', role: 'member' }),
    }),
  });
  Upload.create = async (document) => {
    createdDocument = document;
    return { _id: 'upload-id', ...document, createdAt: new Date() };
  };

  const server = createServer(createApp());
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const body = JSON.stringify({ source: 'const value = 42;' });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/uploads`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signAccessToken({ _id: userId, username: 'developer' })}`,
        'content-type': 'application/json',
        'x-file-name': 'payload.json',
      },
      body,
    });

    assert.equal(response.status, 201);
    assert.equal(createdDocument.mimeType, 'application/json');
    assert.equal(createdDocument.size, Buffer.byteLength(body));
    const savedPath = path.join(UPLOAD_DIR, createdDocument.storedName);
    assert.equal(await readFile(savedPath, 'utf8'), body);
    await rm(savedPath, { force: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findById = originalUserFindById;
    Upload.create = originalUploadCreate;
  }
});

test('authenticated download returns a structured 404 when its stored file is missing', async () => {
  const { createServer } = await import('node:http');
  const { createApp } = await import('../src/app.js');
  const { User } = await import('../src/models/index.js');
  const { signAccessToken } = await import('../src/utils/tokens.js');

  const originalUserFindById = User.findById;
  const originalUploadFindOne = Upload.findOne;
  const userId = '64b000000000000000000001';
  User.findById = () => ({
    select: () => ({
      lean: async () => ({ _id: userId, username: 'developer', displayName: 'Developer', role: 'member' }),
    }),
  });
  Upload.findOne = () => ({
    lean: async () => ({
      _id: 'upload-id',
      uploader: userId,
      storedName: 'missing-content-file.upload',
      originalName: 'missing.txt',
      mimeType: 'text/plain',
      size: 10,
    }),
  });

  const server = createServer(createApp());
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/uploads/upload-id/content`, {
      headers: { authorization: `Bearer ${signAccessToken({ _id: userId, username: 'developer' })}` },
    });
    assert.equal(response.status, 404);
    const payload = await response.json();
    assert.equal(payload.error.code, 'UPLOAD_FILE_NOT_FOUND');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findById = originalUserFindById;
    Upload.findOne = originalUploadFindOne;
  }
});
