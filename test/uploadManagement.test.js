
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { User } from "../src/models/index.js";

import { createApp } from "../src/app.js";
import { User } from "../src/models/index.js";
import { Upload } from "../src/models/upload.js";
import { initializeStorage, UPLOAD_DIR } from "../src/config/storage.js";
import { signAccessToken } from "../src/utils/tokens.js";

const USER_ID = "64b000000000000000000001";

const originalUserFindById = User.findById;
const originalUploadFind = Upload.find;
const originalUploadCountDocuments = Upload.countDocuments;
const originalUploadFindOne = Upload.findOne;
const originalUploadDeleteOne = Upload.deleteOne;

function mockAuthenticatedUser() {
  User.findById = () => ({
    select: () => ({
      lean: async () => ({
        _id: USER_ID,
        username: "developer",
        displayName: "Developer",
        role: "member",
      }),
    }),
  });
}

async function startTestServer() {
  const server = createServer(createApp());

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    server,
    baseUrl,
  };
}

async function stopTestServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function authHeaders() {
  const token = signAccessToken({
    _id: USER_ID,
    username: "developer",
  });

  return {
    Authorization: `Bearer ${token}`,
  };
}

test("GET /api/uploads returns only the authenticated user's uploads", async () => {
  mockAuthenticatedUser();

  let findFilter;
  let countFilter;
  let requestedSkip;
  let requestedLimit;

  const records = [
    {
      _id: "64b000000000000000000002",
      originalName: "hello.js",
      mimeType: "text/javascript",
      size: 120,
      sha256: "a".repeat(64),
      createdAt: new Date("2026-11-25T10:00:00.000Z"),
    },
  ];

  Upload.find = (filter) => {
    findFilter = filter;

    const query = {
      select() {
        return query;
      },
      sort() {
        return query;
      },
      skip(value) {
        requestedSkip = value;
        return query;
      },
      limit(value) {
        requestedLimit = value;
        return query;
      },
      lean: async () => records,
    };

    return query;
  };

  Upload.countDocuments = async (filter) => {
    countFilter = filter;
    return 1;
  };

  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(
      `${baseUrl}/api/uploads?page=1&limit=10`,
      {
        headers: authHeaders(),
      }
    );

    assert.equal(response.status, 200);

    const payload = await response.json();

    assert.deepEqual(findFilter, {
      uploader: USER_ID,
    });

    assert.deepEqual(countFilter, {
      uploader: USER_ID,
    });

    assert.equal(requestedSkip, 0);
    assert.equal(requestedLimit, 10);

    assert.equal(payload.uploads.length, 1);
    assert.equal(payload.uploads[0].originalName, "hello.js");
    assert.equal(payload.uploads[0].id, records[0]._id);

    assert.deepEqual(payload.pagination, {
      page: 1,
      limit: 10,
      total: 1,
      totalPages: 1,
    });
  } finally {
    await stopTestServer(server);
  }
});

test("GET /api/uploads rejects an invalid page number", async () => {
  mockAuthenticatedUser();

  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(
      `${baseUrl}/api/uploads?page=0`,
      {
        headers: authHeaders(),
      }
    );

    assert.equal(response.status, 400);

    const payload = await response.json();

    assert.equal(payload.error.code, "INVALID_PAGE");
  } finally {
    await stopTestServer(server);
  }
});

test("DELETE /api/uploads/:id removes the owned file and metadata", async () => {
  mockAuthenticatedUser();
  await initializeStorage();

  const storedName = `${randomUUID()}.upload`;
  const filePath = path.join(UPLOAD_DIR, storedName);

  await writeFile(filePath, "console.log('test');");

  const uploadRecord = {
    _id: "64b000000000000000000003",
    uploader: USER_ID,
    originalName: "test.js",
    storedName,
    mimeType: "text/javascript",
    size: 21,
    sha256: "b".repeat(64),
  };

  let findOneFilter;
  let deleteFilter;

  Upload.findOne = (filter) => {
    findOneFilter = filter;

    return {
      lean: async () => uploadRecord,
    };
  };

  Upload.deleteOne = async (filter) => {
    deleteFilter = filter;
    return { deletedCount: 1 };
  };

  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(
      `${baseUrl}/api/uploads/${uploadRecord._id}`,
      {
        method: "DELETE",
        headers: authHeaders(),
      }
    );

    assert.equal(response.status, 200);

    const payload = await response.json();

    assert.equal(
      payload.message,
      "Upload deleted successfully"
    );

    assert.deepEqual(findOneFilter, {
      _id: uploadRecord._id,
      uploader: USER_ID,
    });

    assert.deepEqual(deleteFilter, {
      _id: uploadRecord._id,
      uploader: USER_ID,
    });

    await assert.rejects(readFile(filePath));
  } finally {
    await stopTestServer(server);
    await rm(filePath, { force: true });
  }
});

test("DELETE /api/uploads/:id returns 404 for an upload not owned by the user", async () => {
  mockAuthenticatedUser();

  Upload.findOne = () => ({
    lean: async () => null,
  });

  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(
      `${baseUrl}/api/uploads/64b000000000000000000004`,
      {
        method: "DELETE",
        headers: authHeaders(),
      }
    );

    assert.equal(response.status, 404);

    const payload = await response.json();

    assert.equal(payload.error.code, "UPLOAD_NOT_FOUND");
  } finally {
    await stopTestServer(server);
  }
});

after(() => {
  User.findById = originalUserFindById;
  Upload.find = originalUploadFind;
  Upload.countDocuments = originalUploadCountDocuments;
  Upload.findOne = originalUploadFindOne;
  Upload.deleteOne = originalUploadDeleteOne;
});
