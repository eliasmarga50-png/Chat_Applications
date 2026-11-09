// Run with the server already running:  npm run verify:socket
import assert from 'node:assert/strict';
import { io as connectClient } from 'socket.io-client';

const URL = `http://localhost:${process.env.PORT ?? 4000}`;
const sockets = [];

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

// Resolves with the ack; rejects if the server never answers within 3s.
const call = (socket, event, payload) => socket.timeout(3000).emitWithAck(event, payload);

// Must be created BEFORE the action that triggers the event.
const waitFor = (socket, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), ms);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });

async function main() {
  console.log('\n--- 1. Handshake rejection ---');
  await assert.rejects(connect(undefined), (e) => e.data?.code === 'AUTH_REQUIRED');
  console.log('  OK -> missing username rejected (AUTH_REQUIRED)');
  await assert.rejects(connect('nobody_here'), (e) => e.data?.code === 'AUTH_FAILED');
  console.log('  OK -> unknown user rejected (AUTH_FAILED)');

  console.log('\n--- 2. Join + broadcast ---');
  const ada = await connect('ada');
  const linus = await connect('linus');
  const grace = await connect('grace');
  console.log('  OK -> ada, linus, grace connected');

  const joinedNotice = waitFor(ada, 'room:user_joined');
  assert.equal((await call(ada, 'room:join', { slug: 'javascript' })).ok, true);
  assert.equal((await call(linus, 'room:join', { slug: 'javascript' })).ok, true);
  assert.equal((await joinedNotice).user.username, 'linus');
  console.log('  OK -> ada was told linus joined');

  const atLinus = waitFor(linus, 'message:new');
  const atAda = waitFor(ada, 'message:new');
  const ack = await call(ada, 'message:send', { slug: 'javascript', content: '  hello room  ' });
  assert.equal(ack.ok, true);
  const msg = await atLinus;
  assert.equal(msg.content, 'hello room');            // trimmed
  assert.equal(msg.sender.username, 'ada');
  assert.equal((await atAda).id, msg.id);             // sender gets the echo too
  console.log('  OK -> message reached every socket in the room, including the sender');

  console.log('\n--- 3. Room isolation & authorization ---');
  const denied = await call(grace, 'room:join', { slug: 'core-team' });
  assert.equal(denied.error.code, 'ROOM_ACCESS_DENIED');
  console.log('  OK -> non-member refused private room');
  assert.equal((await call(ada, 'room:join', { slug: 'core-team' })).ok, true);

  let leaked = false;
  grace.once('message:new', () => { leaked = true; });
  await call(ada, 'message:send', { slug: 'core-team', content: 'private' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(leaked, false);
  console.log('  OK -> private message did not reach an outside socket');

  const notIn = await call(grace, 'message:send', { slug: 'javascript', content: 'sneaky' });
  assert.equal(notIn.error.code, 'NOT_IN_ROOM');
  console.log('  OK -> sending without joining refused (NOT_IN_ROOM)');

  console.log('\n--- 4. Bad input never crashes the server ---');
  assert.equal((await call(ada, 'room:join', 42)).error.code, 'INVALID_ROOM_SLUG');
  assert.equal((await call(ada, 'room:join', null)).error.code, 'INVALID_ROOM_SLUG');
  assert.equal((await call(ada, 'room:join', { slug: 'nope-room' })).error.code, 'ROOM_NOT_FOUND');
  assert.equal(
    (await call(ada, 'message:send', { slug: 'javascript', content: 'x'.repeat(4001) })).error.code,
    'INVALID_MESSAGE'
  );
  assert.equal(
    (await call(ada, 'message:send', { slug: 'javascript', content: { $ne: 1 } })).error.code,
    'INVALID_MESSAGE'
  );
  console.log('  OK -> garbage payloads answered with structured errors');
  assert.equal((await call(ada, 'message:send', { slug: 'javascript', content: 'still alive' })).ok, true);
  console.log('  OK -> server still serving after bad input');

  console.log('\n--- 5. Disconnect notification ---');
  const leftNotice = waitFor(ada, 'room:user_left');
  linus.disconnect();
  assert.equal((await leftNotice).user.username, 'linus');
  console.log('  OK -> ada was told linus left');

  console.log('\nAll Step 3 checks passed.');
}

main()
  .catch((err) => {
    console.error('\nVerification failed:', err);
    process.exitCode = 1;
  })
  .finally(() => sockets.forEach((s) => s.disconnect()));