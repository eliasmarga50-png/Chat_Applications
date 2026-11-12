import assert from 'node:assert/strict';

import { io as connectClient } from 'socket.io-client';

import { env } from '../src/config/env.js';

import {
  connectDB,
  disconnectDB,
} from '../src/config/db.js';

import { Message } from '../src/models/index.js';

const URL = `http://localhost:${env.PORT}`;
const DEV_PASSWORD = 'devpassword123';

let socket;

function logSuccess(message) {
  console.log(`  OK ${message}`);
}

async function login(username) {
  const response = await fetch(
    `${URL}/api/auth/login`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username,
        password: DEV_PASSWORD,
      }),
    }
  );

  const body = await response.json();

  assert.equal(
    response.status,
    200,
    `Login failed for ${username}`
  );

  assert.ok(
    body.token,
    'Login response must contain a token'
  );

  return body;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    socket = connectClient(URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });

    socket.once('connect', () => {
      resolve(socket);
    });

    socket.once('connect_error', reject);
  });
}

function call(event, payload) {
  return socket
    .timeout(5000)
    .emitWithAck(event, payload);
}

function waitFor(event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, listener);

      reject(
        new Error(`Timeout waiting for ${event}`)
      );
    }, timeoutMs);

    function listener(data) {
      clearTimeout(timer);
      resolve(data);
    }

    socket.once(event, listener);
  });
}

async function sendAndVerify(content) {
  // Subscribe before sending to avoid missing the event.
  const broadcastPromise = waitFor('message:new');

  const ack = await call(
    'message:send',
    {
      slug: 'javascript',
      content,
    }
  );

  assert.equal(
    ack.ok,
    true,
    `Message sending failed: ${JSON.stringify(ack)}`
  );

  const broadcast = await broadcastPromise;

  assert.ok(
    broadcast.id,
    'Broadcast must contain a message ID'
  );

  // Verify the actual MongoDB document.
  const stored = await Message.findById(
    broadcast.id
  ).lean();

  assert.ok(
    stored,
    'Message must exist in MongoDB'
  );

  assert.equal(
    stored.content,
    broadcast.content,
    'MongoDB content and broadcast content must match'
  );

  return {
    broadcast,
    stored,
  };
}

async function main() {
  await connectDB();

  console.log('\n======================================');
  console.log(' DEVELOPER CONTENT SECURITY TESTS');
  console.log('======================================');

  // --------------------------------------
  // 1. AUTHENTICATION
  // --------------------------------------

  console.log('\n1. Authentication');

  const adaLogin = await login('ada');

  logSuccess('Ada authenticated successfully');

  // --------------------------------------
  // 2. SOCKET CONNECTION
  // --------------------------------------

  console.log('\n2. Socket connection');

  await connect(adaLogin.token);

  assert.ok(socket.connected);

  logSuccess('Socket connected successfully');

  // --------------------------------------
  // 3. ROOM MEMBERSHIP
  // --------------------------------------

  console.log('\n3. Room membership');

  const joinResult = await call(
    'room:join',
    {
      slug: 'javascript',
    }
  );

  assert.equal(
    joinResult.ok,
    true,
    `Room join failed: ${JSON.stringify(joinResult)}`
  );

  logSuccess('Joined #javascript successfully');

  // --------------------------------------
  // 4. MALICIOUS HTML
  // --------------------------------------

  console.log('\n4. XSS protection');

  const maliciousContent =
    '<script>alert("XSS")</script>' +
    '<p onclick="alert(1)">Safe developer message</p>';

  const maliciousResult = await sendAndVerify(
    maliciousContent
  );

  const safeContent =
    maliciousResult.broadcast.content;

  assert.doesNotMatch(
    safeContent,
    /<script/i
  );

  assert.doesNotMatch(
    safeContent,
    /onclick/i
  );

  assert.match(
    safeContent,
    /Safe developer message/
  );

  assert.equal(
    maliciousResult.stored.content,
    safeContent
  );

  logSuccess(
    'Malicious HTML neutralized before persistence and broadcast'
  );

  // --------------------------------------
  // 5. DEVELOPER CODE PRESERVATION
  // --------------------------------------

  console.log('\n5. Developer code preservation');

  const developerCode = [
    'Example HTML code:',
    '',
    '```html',
    '<script>alert("This is example code")</script>',
    '<button onclick="example()">Example</button>',
    '```',
  ].join('\n');

  const codeResult = await sendAndVerify(
    developerCode
  );

  assert.equal(
    codeResult.broadcast.content,
    developerCode
  );

  assert.equal(
    codeResult.stored.content,
    developerCode
  );

  logSuccess(
    'HTML examples inside fenced code preserved exactly'
  );

  // --------------------------------------
  // 6. MALICIOUS MARKDOWN LINKS
  // --------------------------------------

  console.log('\n6. Dangerous Markdown URLs');

  const dangerousLink =
    '[Click here](javascript:alert(1))';

  const linkResult = await sendAndVerify(
    dangerousLink
  );

  assert.doesNotMatch(
    linkResult.broadcast.content,
    /javascript:/i
  );

  assert.match(
    linkResult.broadcast.content,
    /#blocked/
  );

  logSuccess(
    'Dangerous Markdown URL neutralized'
  );

  // --------------------------------------
  // RESULTS
  // --------------------------------------

  console.log('\n======================================');
  console.log(' DEVELOPER CONTENT SECURITY: SUCCESS');
  console.log('======================================\n');
}

main()
  .catch((error) => {
    console.error(
      '\nSecurity verification failed:',
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    if (socket) {
      socket.disconnect();
    }

    try {
      await disconnectDB();
    } catch (error) {
      console.error(
        '[security] MongoDB cleanup failed:',
        error.message
      );
    }
  });