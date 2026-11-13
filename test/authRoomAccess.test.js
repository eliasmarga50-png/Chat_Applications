
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { User, RoomMember } from '../src/models/index.js';
import { requireAuth } from '../src/middleware/requireAuth.js';
import { ensureRoomAccess } from '../src/utils/roomAccess.js';
import { signAccessToken } from '../src/utils/tokens.js';

const USER_ID = '64b000000000000000000001';

const originalFindById = User.findById;
const originalRoomMemberExists = RoomMember.exists;

afterEach(() => {
  User.findById = originalFindById;
  RoomMember.exists = originalRoomMemberExists;
});

function createRequest(authorization) {
  return {
    headers: authorization === undefined
      ? {}
      : { authorization },
  };
}

test('requireAuth rejects a request without an Authorization header', async () => {
  const req = createRequest();
  let nextCalled = false;

  await assert.rejects(
    requireAuth(req, {}, () => {
      nextCalled = true;
    }),
    (error) => error.statusCode === 401 && error.code === 'AUTH_REQUIRED',
  );

  assert.equal(nextCalled, false);
});

test('requireAuth rejects a malformed Bearer header', async () => {
  const req = createRequest('Basic some-token');

  await assert.rejects(
    requireAuth(req, {}, () => {}),
    (error) => error.statusCode === 401 && error.code === 'AUTH_REQUIRED',
  );
});

test('requireAuth rejects an invalid JWT', async () => {
  const req = createRequest('Bearer definitely-not-a-valid-jwt');

  await assert.rejects(
    requireAuth(req, {}, () => {}),
    (error) => error.statusCode === 401 && error.code === 'INVALID_TOKEN',
  );
});

test('requireAuth rejects a validly signed token with an invalid user ID', async () => {
  const token = signAccessToken({
    _id: 'not-a-valid-object-id',
    username: 'developer',
  });

  const req = createRequest(`Bearer ${token}`);

  await assert.rejects(
    requireAuth(req, {}, () => {}),
    (error) => error.statusCode === 401 && error.code === 'INVALID_TOKEN',
  );
});

test('requireAuth rejects a token when its user no longer exists', async () => {
  const token = signAccessToken({
    _id: USER_ID,
    username: 'developer',
  });

  User.findById = () => ({
    select() {
      return {
        lean: async () => null,
      };
    },
  });

  const req = createRequest(`Bearer ${token}`);

  await assert.rejects(
    requireAuth(req, {}, () => {}),
    (error) => error.statusCode === 401 && error.code === 'INVALID_TOKEN',
  );
});

test('requireAuth attaches the database user to the request', async () => {
  const token = signAccessToken({
    _id: USER_ID,
    username: 'developer',
  });

  const databaseUser = {
    _id: USER_ID,
    username: 'developer',
    displayName: 'Developer',
    role: 'member',
  };

  let selectedFields;

  User.findById = (id) => {
    assert.equal(String(id), USER_ID);

    return {
      select(fields) {
        selectedFields = fields;

        return {
          lean: async () => databaseUser,
        };
      },
    };
  };

  const req = createRequest(`Bearer ${token}`);
  let nextCalled = false;

  await requireAuth(req, {}, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(selectedFields, 'username displayName role');

  assert.deepEqual(req.user, {
    _id: USER_ID,
    id: USER_ID,
    username: 'developer',
    displayName: 'Developer',
    role: 'member',
  });
});

test('public rooms can be accessed without membership', async () => {
  let membershipChecked = false;

  RoomMember.exists = async () => {
    membershipChecked = true;
    return null;
  };

  await assert.doesNotReject(
    ensureRoomAccess(
      { _id: 'public-room-id', isPrivate: false },
      undefined,
    ),
  );

  assert.equal(membershipChecked, false);
});

test('private rooms reject unauthenticated users', async () => {
  let membershipChecked = false;

  RoomMember.exists = async () => {
    membershipChecked = true;
    return null;
  };

  await assert.rejects(
    ensureRoomAccess(
      { _id: 'private-room-id', isPrivate: true },
      undefined,
    ),
    (error) => error.statusCode === 401 && error.code === 'AUTH_REQUIRED',
  );

  assert.equal(membershipChecked, false);
});

test('private rooms reject authenticated non-members', async () => {
  RoomMember.exists = async (query) => {
    assert.deepEqual(query, {
      room: 'private-room-id',
      user: USER_ID,
    });

    return null;
  };

  await assert.rejects(
    ensureRoomAccess(
      { _id: 'private-room-id', isPrivate: true },
      USER_ID,
    ),
    (error) => error.statusCode === 403 && error.code === 'ROOM_ACCESS_DENIED',
  );
});

test('private rooms allow authenticated members', async () => {
  RoomMember.exists = async (query) => {
    assert.deepEqual(query, {
      room: 'private-room-id',
      user: USER_ID,
    });

    return { _id: 'membership-id' };
  };

  await assert.doesNotReject(
    ensureRoomAccess(
      { _id: 'private-room-id', isPrivate: true },
      USER_ID,
    ),
  );
});
