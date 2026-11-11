
/**
 * Realtime Presence & Persistence Verification
 *
 * Run with:
 *   npm run verify:re
 *
 * Requirements:
 *   - Backend server already running.
 *   - Database seeded using npm run seed.
 *   - MongoDB reachable.
 */

import assert from 'node:assert/strict';

import { io as connectClient } from 'socket.io-client';

import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Message } from '../src/models/index.js';

const URL = `http://localhost:${env.PORT}`;
const DEV_PASSWORD = 'devpassword123';

const sockets = [];

let testsPassed = 0;

// ----------------------------------------
// HELPERS
// ----------------------------------------

function logSuccess(message) {
  testsPassed++;

  console.log(`  OK ${message}`);
}

async function login(username, password = DEV_PASSWORD) {
  const response = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username,
      password,
    }),
  });

  const body = await response.json();

  assert.equal(
    response.status,
    200,
    `Login failed for ${username}`
  );

  assert.ok(body.token, 'Login must return a JWT');

  return body;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });

    sockets.push(socket);

    socket.once('connect', () => resolve(socket));

    socket.once('connect_error', reject);
  });
}

function call(socket, event, payload) {
  return socket
    .timeout(5000)
    .emitWithAck(event, payload);
}

function waitFor(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);

      reject(
        new Error(`Timeout waiting for "${event}"`)
      );
    }, timeoutMs);

    function listener(data) {
      clearTimeout(timer);
      resolve(data);
    }

    socket.once(event, listener);
  });
}

function waitForCount(socket, expectedCount) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('presence:count', listener);

      reject(
        new Error(
          `Timeout waiting for online count ${expectedCount}`
        )
      );
    }, 5000);

    function listener(data) {
      if (data.onlineUsers !== expectedCount) {
        return;
      }

      clearTimeout(timer);
      resolve(data);
    }

    socket.on('presence:count', listener);
  });
}

async function joinRoom(socket, slug = 'javascript') {
  const result = await call(socket, 'room:join', {
    slug,
  });

  assert.equal(
    result.ok,
    true,
    `Room join failed: ${JSON.stringify(result)}`
  );

  return result;
}

// ----------------------------------------
// TESTS
// ----------------------------------------

async function main() {
  await connectDB();

  console.log('\n======================================');
  console.log(' REALTIME STATE & PERSISTENCE TESTS');
  console.log('======================================');

  // --------------------------------------
  // 1. REST LOGIN
  // --------------------------------------

  console.log('\n1. Authentication');

  const adaLogin = await login('ada');
  const linusLogin = await login('linus');
  
const adaId =
  adaLogin.user.id ??
  adaLogin.user._id;

const linusId =
  linusLogin.user.id ??
  linusLogin.user._id;

assert.ok(adaId);
assert.ok(linusId);

  logSuccess('Ada and Linus authenticated successfully');

  // --------------------------------------
  // 2. ONLINE USER COUNT
  // --------------------------------------

  console.log('\n2. Online presence');

  const ada = await connect(adaLogin.token);

  assert.ok(ada.connected);

  // Ada should be the first online user.
  const linusCount = waitForCount(ada, 2);

  const linus = await connect(linusLogin.token);

  await linusCount;

  logSuccess('Online count increased to 2');

  // --------------------------------------
  // 3. MULTIPLE SOCKETS PER USER
  // --------------------------------------

  console.log('\n3. Multiple sockets');

  // Listen before connecting the second Ada socket.
  const countShouldRemainTwo = waitForCount(ada, 2);

  const adaSecondTab = await connect(adaLogin.token);

  await countShouldRemainTwo;

  logSuccess(
    'Second Ada socket did not increase unique online user count'
  );

  // Disconnect only one of Ada's sockets.
  const countStillTwo = waitForCount(ada, 2);

  adaSecondTab.disconnect();

  await countStillTwo;

  logSuccess(
    'Ada remains online while her first socket is connected'
  );

  // --------------------------------------
  // 4. ROOM JOIN
  // --------------------------------------

  console.log('\n4. Room membership');

  await joinRoom(ada);
  await joinRoom(linus);

  logSuccess('Both users joined #javascript');

  // --------------------------------------
  // 5. MESSAGE BROADCAST + PERSISTENCE
  // --------------------------------------

  console.log('\n5. Message persistence');

  const content =
    `Realtime verification ${Date.now()}`;

  const messageReceived = waitFor(
    linus,
    'message:new'
  );

  const ack = await call(
    ada,
    'message:send',
    {
      slug: 'javascript',
      content,
    }
  );

  assert.equal(
    ack.ok,
    true,
    `Message send failed: ${JSON.stringify(ack)}`
  );

  const broadcastMessage = await messageReceived;

  assert.equal(
    broadcastMessage.content,
    content
  );

  assert.equal(
    broadcastMessage.sender.username,
    'ada'
  );

  assert.ok(
    broadcastMessage.id,
    'Message should contain MongoDB ID'
  );

  logSuccess('Message broadcast to Linus');

  // Query MongoDB directly to verify persistence.
  const savedMessage = await Message.findById(
    broadcastMessage.id
  ).lean();

  assert.ok(
    savedMessage,
    'Message must exist in MongoDB'
  );

  assert.equal(savedMessage.content, content);

  assert.equal(
    String(savedMessage.sender),
    adaId
  );

  assert.ok(savedMessage.createdAt);

  logSuccess(
    'Message exists in MongoDB with correct sender and timestamp'
  );

  // --------------------------------------
  // 6. TYPING INDICATORS
  // --------------------------------------

  console.log('\n6. Typing indicators');

  const typingStarted = waitFor(
    linus,
    'typing:update'
  );

  const startAck = await call(
    ada,
    'typing:start',
    {
      slug: 'javascript',
    }
  );

  assert.equal(startAck.ok, true);

  const started = await typingStarted;

  assert.equal(started.userId, adaId);
  assert.equal(started.room, 'javascript');
  assert.equal(started.isTyping, true);

  logSuccess('Typing start broadcast received');

  const typingStopped = waitFor(
    linus,
    'typing:update'
  );

  const stopAck = await call(
    ada,
    'typing:stop',
    {
      slug: 'javascript',
    }
  );

  assert.equal(stopAck.ok, true);

  const stopped = await typingStopped;

  assert.equal(stopped.userId, adaId);
  assert.equal(stopped.isTyping, false);

  logSuccess('Typing stop broadcast received');

  // --------------------------------------
  // 7. DISCONNECT CLEANUP
  // --------------------------------------

  console.log('\n7. Disconnect cleanup');

  const offlineNotice = waitFor(
    linus,
    'presence:user_offline'
  );

  const countShouldBecomeOne = waitForCount(
    linus,
    1
  );

  ada.disconnect();

  const offline = await offlineNotice;

  await countShouldBecomeOne;

  assert.equal(offline.userId, adaId);

  logSuccess(
    'Ada marked offline after her final socket disconnected'
  );

  logSuccess('Online user count decreased to 1');

  // --------------------------------------
  // 8. INVALID EVENT SURVIVAL
  // --------------------------------------

  console.log('\n8. Error handling');

  const invalid = await call(
    linus,
    'message:send',
    {
      slug: 'javascript',
      content: '',
    }
  );

  assert.equal(invalid.ok, false);

  assert.equal(
    invalid.error.code,
    'INVALID_MESSAGE'
  );

  // The same socket should still be usable.
  const validAfterInvalid = await call(
    linus,
    'message:send',
    {
      slug: 'javascript',
      content: 'Still alive',
    }
  );

  assert.equal(validAfterInvalid.ok, true);

  logSuccess(
    'Invalid message rejected without disconnecting the client'
  );

  // --------------------------------------
  // RESULTS
  // --------------------------------------

  console.log('\n======================================');
  console.log(` PASSED: ${testsPassed} verification checks`);
  console.log(' REALTIME STATE & PERSISTENCE: SUCCESS');
  console.log('======================================\n');
}

main()
  .catch((error) => {
    console.error('\nVerification failed:', error);
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
        '[verify] MongoDB cleanup failed:',
        error.message
      );
    }
  });
