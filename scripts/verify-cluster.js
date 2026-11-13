
/**
 * Cross-Worker Messaging Verification
 *
 * Verifies:
 *   1. Ada and Linus connect to different Node.js workers.
 *   2. A message sent by Ada reaches Linus across workers.
 *   3. The message is persisted in MongoDB.
 *   4. Exactly one MongoDB document exists for the test message.
 *
 * Requirements:
 *   - Redis running.
 *   - Cluster server running.
 *   - Database seeded with Ada and Linus.
 *
 * Run:
 *   npm run verify:cluster
 */

import assert from 'node:assert/strict';

import { io as connectClient } from 'socket.io-client';

import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Message, Room } from '../src/models/index.js';

const URL = `http://localhost:${env.PORT}`;
const DEV_PASSWORD = 'devpassword123';

const sockets = [];

let testsPassed = 0;

function logSuccess(message) {
  testsPassed++;
  console.log(`  OK ${message}`);
}

async function login(username) {
  const response = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username,
      password: DEV_PASSWORD,
    }),
  });

  const body = await response.json();

  assert.equal(
    response.status,
    200,
    `Login failed for ${username}: ${JSON.stringify(body)}`
  );

  assert.ok(body.token);

  return body;
}

function connect(token, username) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });

    sockets.push(socket);

    let instancePid;
    let settled = false;

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Worker identification timed out for ${username}`
        )
      );
    }, 15000);

    function finish(error, result) {
      if (settled) return;

      settled = true;
      clearTimeout(timeout);

      if (error) {
        socket.disconnect();
        reject(error);
      } else {
        resolve(result);
      }
    }

    socket.on('server:instance', (data) => {
      instancePid = data?.pid;

      if (socket.connected && instancePid !== undefined) {
        finish(null, {
          socket,
          pid: instancePid,
          username,
        });
      }
    });

    socket.once('connect', () => {
      if (instancePid !== undefined) {
        finish(null, {
          socket,
          pid: instancePid,
          username,
        });
      }
    });

    socket.once('connect_error', (error) => {
      finish(error);
    });
  });
}

function call(socket, event, payload) {
  return socket.timeout(10000).emitWithAck(event, payload);
}

function waitFor(socket, event, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timeout waiting for ${event}`));
    }, timeoutMs);

    function listener(data) {
      clearTimeout(timeout);
      resolve(data);
    }

    socket.once(event, listener);
  });
}

async function joinRoom(socket, slug) {
  const result = await call(socket, 'room:join', { slug });

  assert.equal(
    result.ok,
    true,
    `Room join failed: ${JSON.stringify(result)}`
  );
}

async function connectToDifferentWorkers(tokenA, tokenB) {
  console.log('  Opening authenticated connections...');

  // Windows cluster connection distribution may vary.
  // Use multiple authenticated connections to discover workers.
  const attempts = 32;

  const clients = await Promise.all(
    Array.from({ length: attempts }, (_, index) => {
      const isAda = index % 2 === 0;

      return connect(
        isAda ? tokenA : tokenB,
        isAda ? 'ada' : 'linus'
      );
    })
  );

  const workerPids = new Set(
    clients.map((client) => client.pid)
  );

  console.log(
    `  Observed ${clients.length} connections across ` +
    `${workerPids.size} worker(s)`
  );

  for (const pid of workerPids) {
    const count = clients.filter(
      (client) => client.pid === pid
    ).length;

    console.log(`    Worker ${pid}: ${count} connections`);
  }

  // Find Ada and Linus specifically on different workers.
  const workerA = clients.find(
    (client) =>
      client.username === 'ada' &&
      clients.some(
        (candidate) =>
          candidate.username === 'linus' &&
          candidate.pid !== client.pid
      )
  );

  if (!workerA) {
    throw new Error(
      'Could not find Ada and Linus on separate workers. ' +
      `Observed worker PIDs: ${[...workerPids].join(', ')}`
    );
  }

  const workerB = clients.find(
    (client) =>
      client.username === 'linus' &&
      client.pid !== workerA.pid
  );

  assert.ok(workerB);

  return {
    workerA,
    workerB,
  };
}

async function main() {
  console.log('\n======================================');
  console.log(' CROSS-WORKER MESSAGING VERIFICATION');
  console.log('======================================');

  assert.ok(
    env.REDIS_URL,
    'REDIS_URL must be configured for cross-worker testing'
  );

  assert.equal(
    env.REQUIRE_REDIS_ADAPTER,
    true,
    'REQUIRE_REDIS_ADAPTER must be true'
  );

  await connectDB();

  // --------------------------------------
  // 1. AUTHENTICATION
  // --------------------------------------

  console.log('\n1. Authentication');

  const adaLogin = await login('ada');
  const linusLogin = await login('linus');

  const adaId = adaLogin.user.id ?? adaLogin.user._id;
  const linusId = linusLogin.user.id ?? linusLogin.user._id;

  assert.ok(adaId);
  assert.ok(linusId);

  logSuccess('Ada and Linus authenticated');

  // --------------------------------------
  // 2. DIFFERENT WORKERS
  // --------------------------------------

  console.log('\n2. Worker distribution');

  const { workerA, workerB } =
    await connectToDifferentWorkers(
      adaLogin.token,
      linusLogin.token
    );

  assert.equal(workerA.username, 'ada');
  assert.equal(workerB.username, 'linus');

  assert.notEqual(
    workerA.pid,
    workerB.pid,
    'Clients must connect to different worker processes'
  );

  console.log(`  Ada (Worker A): ${workerA.pid}`);
  console.log(`  Linus (Worker B): ${workerB.pid}`);

  logSuccess('Ada and Linus connected to separate workers');

  const ada = workerA.socket;
  const linus = workerB.socket;

  // --------------------------------------
  // 3. ROOM MEMBERSHIP
  // --------------------------------------

  console.log('\n3. Room membership');

  await joinRoom(ada, 'javascript');
  await joinRoom(linus, 'javascript');

  logSuccess('Both workers joined #javascript');

  // --------------------------------------
  // 4. CROSS-WORKER MESSAGE DELIVERY
  // --------------------------------------

  console.log('\n4. Cross-worker message delivery');

  const uniqueContent =
    `Cross-worker verification ${Date.now()}-${process.pid}`;

  const receivedPromise = waitFor(
    linus,
    'message:new'
  );

  const acknowledgement = await call(
    ada,
    'message:send',
    {
      slug: 'javascript',
      content: uniqueContent,
    }
  );

  assert.equal(
    acknowledgement.ok,
    true,
    `Message failed: ${JSON.stringify(acknowledgement)}`
  );

  const receivedMessage = await receivedPromise;

  assert.equal(receivedMessage.content, uniqueContent);
  assert.equal(receivedMessage.sender.username, 'ada');
  assert.ok(receivedMessage.id);

  logSuccess(
    `Worker ${workerA.pid} message received by worker ${workerB.pid}`
  );

  // --------------------------------------
  // 5. DATABASE PERSISTENCE
  // --------------------------------------

  console.log('\n5. MongoDB persistence');

  const savedMessage = await Message.findById(
    receivedMessage.id
  ).lean();

  assert.ok(savedMessage, 'Message missing from MongoDB');

  assert.equal(savedMessage.content, uniqueContent);

  assert.equal(
    String(savedMessage.sender),
    String(adaId)
  );

  assert.ok(savedMessage.createdAt);

  const room = await Room.findOne({
    slug: 'javascript',
  }).lean();

  assert.ok(room, 'Test room does not exist');

  assert.equal(
    String(savedMessage.room),
    String(room._id)
  );

  logSuccess(
    'Message persisted with correct room, sender and content'
  );

  // --------------------------------------
  // 6. EXACTLY-ONCE PERSISTENCE
  // --------------------------------------

  console.log('\n6. Exactly-once persistence');

  const matchingDocuments = await Message.countDocuments({
    room: room._id,
    sender: adaId,
    content: uniqueContent,
  });

  assert.equal(
    matchingDocuments,
    1,
    `Expected exactly one document, found ${matchingDocuments}`
  );

  logSuccess(
    'Exactly one MongoDB document exists for the message'
  );

  // --------------------------------------
  // RESULTS
  // --------------------------------------

  console.log('\n======================================');
  console.log(` PASSED: ${testsPassed} verification checks`);
  console.log(' CROSS-WORKER MESSAGING: SUCCESS');
  console.log('======================================\n');
}

main()
  .catch((error) => {
    console.error('\nCross-worker verification failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const socket of sockets) {
      socket.disconnect();
    }

    try {
      await disconnectDB();
    } catch (error) {
      console.error(
        '[verify:cluster] MongoDB cleanup failed:',
        error.message
      );
    }
  });
