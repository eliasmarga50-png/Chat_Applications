// Run with the server already running:  npm run verify:socket
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { io as connectClient } from 'socket.io-client';
import { env } from '../src/config/env.js';
import { ISSUER, AUDIENCE } from '../src/utils/tokens.js';

const URL = `http://localhost:${env.PORT}`;
const DEV_PASSWORD = 'devpassword123'; // set by scripts/seed.js
const sockets = [];

// ---------- helpers ----------
async function login(username, password = DEV_PASSWORD) {
  const res = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: await res.json() };
}

// token       -> sent as handshake.auth.token (what a browser does)
// headerToken -> sent as "Authorization: Bearer" (what Node clients/proxies do)
function connect({ token, headerToken } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(URL, {
      auth: token ? { token } : {},
      extraHeaders: headerToken ? { Authorization: `Bearer ${headerToken}` } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const call = (socket, event, payload) => socket.timeout(3000).emitWithAck(event, payload);

// Create BEFORE the action that triggers the event.
const waitFor = (socket, event, ms = 3000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), ms);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });

const now = () => Math.floor(Date.now() / 1000);
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// Signs a token with full control over claims, for crafting bad ones.
const forge = (claims, secret = env.JWT_SECRET) =>
  jwt.sign({ iss: ISSUER, aud: AUDIENCE, ...claims }, secret, { algorithm: 'HS256' });

const expectReject = (opts, code) =>
  assert.rejects(connect(opts), (e) => e.data?.code === code, `expected ${code}`);

// ---------- tests ----------
async function main() {
  console.log('\n--- 1. REST login ---');
  const adaLogin = await login('ada');
  assert.equal(adaLogin.status, 200);
  assert.ok(adaLogin.body.token, 'login must return a token');
  assert.equal(adaLogin.body.user.passwordHash, undefined, 'hash must never be serialized');
  console.log('  OK -> ada logged in, token issued, no passwordHash in response');

  const wrongPw = await login('ada', 'not-the-password');
  const noUser = await login('nobody_here');
  assert.equal(wrongPw.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(noUser.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(wrongPw.status, 401);
  console.log('  OK -> wrong password and unknown user get the same 401');

  const injected = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ada', password: { $ne: null } }),
  });
  assert.equal(injected.status, 400);
  console.log('  OK -> operator-injection payload rejected (400)');

  const adaId = adaLogin.body.user.id ?? adaLogin.body.user._id;
  assert.ok(adaId, 'user id missing from login response');

  console.log('\n--- 2. Handshake rejection (server must survive all of these) ---');
  await expectReject({}, 'AUTH_REQUIRED');
  console.log('  OK -> no token                     -> AUTH_REQUIRED');
  await expectReject({ token: 'garbage' }, 'INVALID_TOKEN');
  console.log('  OK -> garbage string               -> INVALID_TOKEN');
  await expectReject({ token: forge({ sub: adaId }, 'x'.repeat(40)) }, 'INVALID_TOKEN');
  console.log('  OK -> signed with the wrong secret -> INVALID_TOKEN');
  await expectReject({ token: forge({ sub: adaId, exp: now() - 10 }) }, 'TOKEN_EXPIRED');
  console.log('  OK -> expired token                -> TOKEN_EXPIRED');
  const noneToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: adaId, iss: ISSUER, aud: AUDIENCE, exp: now() + 3600 })}.`;
  await expectReject({ token: noneToken }, 'INVALID_TOKEN');
  console.log('  OK -> "alg: none" forgery          -> INVALID_TOKEN');
  await expectReject({ token: jwt.sign({ sub: adaId }, env.JWT_SECRET, { expiresIn: 3600 }) }, 'INVALID_TOKEN');
  console.log('  OK -> missing issuer/audience      -> INVALID_TOKEN');
  const ghost = randomBytes(12).toString('hex');
  await expectReject({ token: forge({ sub: ghost, exp: now() + 3600 }) }, 'INVALID_TOKEN');
  console.log('  OK -> valid signature, user not in MongoDB -> INVALID_TOKEN');

  console.log('\n--- 3. Both token transports work ---');
  const viaAuth = await connect({ token: adaLogin.body.token });
  console.log('  OK -> handshake.auth.token accepted');
  viaAuth.disconnect();
  const viaHeader = await connect({ headerToken: adaLogin.body.token });
  console.log('  OK -> Authorization: Bearer header accepted');
  viaHeader.disconnect();

  console.log('\n--- 4. Session expiry on a live socket ---');
  const shortLived = await connect({ token: forge({ sub: adaId, exp: now() + 2 }) });
  const expiredNotice = waitFor(shortLived, 'auth:expired', 5000);
  const closed = waitFor(shortLived, 'disconnect', 5000);
  assert.equal((await expiredNotice).code, 'TOKEN_EXPIRED');
  assert.equal(await closed, 'io server disconnect');
  console.log('  OK -> server pushed auth:expired and closed the socket when the token ran out');

  console.log('\n--- 5. Authenticated chat still works (Step 3 regression) ---');
  const linusLogin = await login('linus');
  const graceLogin = await login('grace');
  const ada = await connect({ token: adaLogin.body.token });
  const linus = await connect({ token: linusLogin.body.token });
  const grace = await connect({ token: graceLogin.body.token });

  const joinedNotice = waitFor(ada, 'room:user_joined');
  assert.equal((await call(ada, 'room:join', { slug: 'javascript' })).ok, true);
  assert.equal((await call(linus, 'room:join', { slug: 'javascript' })).ok, true);
  const joined = await joinedNotice;
  assert.equal(joined.user.username, 'linus');
  assert.equal(joined.user.email, undefined, 'email must not leak to other users');
  console.log('  OK -> join notice carries a public user projection only');

  const atLinus = waitFor(linus, 'message:new');
  assert.equal((await call(ada, 'message:send', { slug: 'javascript', content: 'hello' })).ok, true);
  const msg = await atLinus;
  assert.equal(msg.sender.username, 'ada'); // identity comes from the verified token, never the payload
  console.log('  OK -> sender identity comes from the verified token');

  const denied = await call(grace, 'room:join', { slug: 'core-team' });
  assert.equal(denied.error.code, 'ROOM_ACCESS_DENIED');
  assert.equal((await call(ada, 'room:join', { slug: 'core-team' })).ok, true);
  console.log('  OK -> private-room membership enforced for authenticated users');

  assert.equal((await call(ada, 'room:join', 42)).error.code, 'INVALID_ROOM_SLUG');
  assert.equal((await call(ada, 'message:send', { slug: 'javascript', content: 'still alive' })).ok, true);
  console.log('  OK -> bad payload answered with an error, server still serving');

  console.log('\nAll Step 4 checks passed.');
}

main()
  .catch((err) => {
    console.error('\nVerification failed:', err);
    process.exitCode = 1;
  })
  .finally(() => sockets.forEach((s) => s.disconnect()));