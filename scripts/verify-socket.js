
// Run with the server already running: npm run verify:socket

import assert from 'node:assert/strict';
import { io as connectClient } from 'socket.io-client';

const URL = `http://localhost:${process.env.PORT ?? 4000}`;
const sockets = [];

// Connect a simulated user to the Socket.IO server.
function connect(username) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(URL, {
      auth: username === undefined ? {} : { username },
      transports: ['websocket'],
      reconnection: false,
    });

    sockets.push(socket);

    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

// Send an event and wait for the server's acknowledgement.
// Reject if the server does not respond within 3 seconds.
const call = (socket, event, payload) =>
  socket.timeout(3000).emitWithAck(event, payload);

// Wait for a server event.
// Register this BEFORE the action that triggers the event.
const waitFor = (socket, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for "${event}"`)),
      ms
    );

    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });

async function main() {
  // --------------------------------------------------
  // 1. Handshake rejection
  // --------------------------------------------------

  console.log('\n--- 1. Handshake rejection ---');

  // Missing username must be rejected.
  await assert.rejects(
    connect(undefined),
    (err) => err.data?.code === 'AUTH_REQUIRED'
  );

  console.log('  OK -> missing username rejected (AUTH_REQUIRED)');

  // Unknown username must be rejected.
  await assert.rejects(
    connect('nobody_here'),
    (err) => err.data?.code === 'AUTH_FAILED'
  );

  console.log('  OK -> unknown user rejected (AUTH_FAILED)');

  // --------------------------------------------------
  // 2. Join + broadcast
  // --------------------------------------------------

  console.log('\n--- 2. Join + broadcast ---');

  // Connect three simulated users.
  const ada = await connect('ada');
  const linus = await connect('linus');
  const grace = await connect('grace');

  console.log('  OK -> ada, linus, grace connected');

  // Listen for Ada's notification BEFORE Linus joins.
  const joinedNotice = waitFor(ada, 'room:user_joined');

  // Ada joins the public JavaScript room.
  assert.equal(
    (await call(ada, 'room:join', {
      slug: 'javascript',
    })).ok,
    true
  );

  // Linus joins the same room.
  assert.equal(
    (await call(linus, 'room:join', {
      slug: 'javascript',
    })).ok,
    true
  );

  // Ada must receive a notification that Linus joined.
  assert.equal(
    (await joinedNotice).user.username,
    'linus'
  );

  console.log('  OK -> ada was told linus joined');

  // Listen on both clients BEFORE Ada sends a message.
  const atLinus = waitFor(linus, 'message:new');
  const atAda = waitFor(ada, 'message:new');

  // Ada sends a message with extra whitespace.
  const ack = await call(ada, 'message:send', {
    slug: 'javascript',
    content: '  hello room  ',
  });

  assert.equal(ack.ok, true);

  // Linus receives the message.
  const msg = await atLinus;

  // Verify the message content was trimmed.
  assert.equal(msg.content, 'hello room');

  // Verify the sender.
  assert.equal(msg.sender.username, 'ada');

  // Verify Ada also receives the broadcast.
  assert.equal((await atAda).id, msg.id);

  console.log(
    '  OK -> message reached every socket in the room, including the sender'
  );

  // --------------------------------------------------
  // 3. Room isolation & authorization
  // --------------------------------------------------

  console.log('\n--- 3. Room isolation & authorization ---');

  // Grace is not a member of the private core-team room.
  const denied = await call(grace, 'room:join', {
    slug: 'core-team',
  });

  assert.equal(
    denied.error.code,
    'ROOM_ACCESS_DENIED'
  );

  console.log('  OK -> non-member refused private room');

  // Ada is a member and should be allowed to join.
  assert.equal(
    (await call(ada, 'room:join', {
      slug: 'core-team',
    })).ok,
    true
  );

  // Listen for any accidental private-message leak to Grace.
  let leaked = false;

  grace.once('message:new', () => {
    leaked = true;
  });

  // Ada sends a message to the private room.
  await call(ada, 'message:send', {
    slug: 'core-team',
    content: 'private',
  });

  // Give any unexpected broadcast time to arrive.
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(leaked, false);

  console.log('  OK -> private message did not reach an outside socket');

  // Grace tries to send without joining the JavaScript room.
  const notIn = await call(grace, 'message:send', {
    slug: 'javascript',
    content: 'sneaky',
  });

  assert.equal(
    notIn.error.code,
    'NOT_IN_ROOM'
  );

  console.log('  OK -> sending without joining refused (NOT_IN_ROOM)');

  // --------------------------------------------------
  // 4. Bad input never crashes the server
  // --------------------------------------------------

  console.log('\n--- 4. Bad input never crashes the server ---');

  // A number is not a valid object payload.
  assert.equal(
    (await call(ada, 'room:join', 42)).error.code,
    'INVALID_PAYLOAD'
  );

  // Null is not a valid object payload.
  assert.equal(
    (await call(ada, 'room:join', null)).error.code,
    'INVALID_PAYLOAD'
  );

  // Arrays are not valid object payloads.
  assert.equal(
    (await call(ada, 'room:join', [])).error.code,
    'INVALID_PAYLOAD'
  );

  // room:leave must also reject malformed payloads.
  assert.equal(
    (await call(ada, 'room:leave', null)).error.code,
    'INVALID_PAYLOAD'
  );

  // message:send must also reject malformed payloads.
  assert.equal(
    (await call(ada, 'message:send', null)).error.code,
    'INVALID_PAYLOAD'
  );

  console.log('  OK -> malformed payload types rejected (INVALID_PAYLOAD)');

  // A valid object with a nonexistent room must return ROOM_NOT_FOUND.
  assert.equal(
    (await call(ada, 'room:join', {
      slug: 'nope-room',
    })).error.code,
    'ROOM_NOT_FOUND'
  );

  console.log('  OK -> nonexistent room rejected (ROOM_NOT_FOUND)');

  // A message exceeding the 4000-character limit must be rejected.
  assert.equal(
    (
      await call(ada, 'message:send', {
        slug: 'javascript',
        content: 'x'.repeat(4001),
      })
    ).error.code,
    'INVALID_MESSAGE'
  );

  // Message content must be a string.
  assert.equal(
    (
      await call(ada, 'message:send', {
        slug: 'javascript',
        content: { $ne: 1 },
      })
    ).error.code,
    'INVALID_MESSAGE'
  );

  console.log('  OK -> invalid message content rejected (INVALID_MESSAGE)');

  // The server must still accept a valid message after bad requests.
  assert.equal(
    (
      await call(ada, 'message:send', {
        slug: 'javascript',
        content: 'still alive',
      })
    ).ok,
    true
  );

  console.log('  OK -> server still serving after bad input');

  // --------------------------------------------------
  // 5. Disconnect notification
  // --------------------------------------------------

  console.log('\n--- 5. Disconnect notification ---');

  // Ada listens BEFORE Linus disconnects.
  const leftNotice = waitFor(ada, 'room:user_left');

  // Disconnect Linus.
  linus.disconnect();

  // Ada must receive a notification identifying Linus.
  assert.equal(
    (await leftNotice).user.username,
    'linus'
  );

  console.log('  OK -> ada was told linus left');

  // --------------------------------------------------
  // Final result
  // --------------------------------------------------

  console.log('\nAll Step 3 checks passed.');
}

// Execute the verification suite.
main()
  .catch((err) => {
    console.error('\nVerification failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Disconnect every test socket, even if an assertion fails.
    sockets.forEach((socket) => socket.disconnect());
  });
