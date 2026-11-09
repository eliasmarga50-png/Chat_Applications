import assert from 'node:assert/strict';

import { connectDB, disconnectDB } from '../src/config/db.js';

import {
  User,
  Room,
  Message,
  RoomMember,
} from '../src/models/index.js';

import { ensureRoomAccess } from '../src/utils/roomAccess.js';

// Recursively collect stages from different MongoDB explain-plan shapes.
function collectStages(node, results = []) {
  if (!node || typeof node !== 'object') return results;

  if (node.stage) {
    results.push({
      stage: node.stage,
      indexName: node.indexName,
    });
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach((item) => collectStages(item, results));
    } else if (value && typeof value === 'object') {
      collectStages(value, results);
    }
  }

  return results;
}

function printPlan(label, explainResult) {
  const stats = explainResult.executionStats;
  const stages = collectStages(explainResult.queryPlanner.winningPlan);

  console.log(`\n${label}`);
  console.log(
    '  plan          :',
    stages.map((s) =>
      s.indexName ? `${s.stage}(${s.indexName})` : s.stage
    ).join(' -> ')
  );
  console.log('  docsExamined  :', stats.totalDocsExamined);
  console.log('  keysExamined  :', stats.totalKeysExamined);
  console.log('  returned      :', stats.nReturned);

  return stages;
}

async function verifyCompoundPaginationIndex(room) {
  console.log('\n--- 1. Compound pagination index ---');

  const expectedKey = {
    room: 1,
    createdAt: -1,
    _id: -1,
  };

  const indexes = await Message.collection.indexes();

  const compoundIndex = indexes.find((index) =>
    JSON.stringify(Object.entries(index.key)) ===
    JSON.stringify(Object.entries(expectedKey))
  );

  assert.ok(
    compoundIndex,
    'Missing index: { room: 1, createdAt: -1, _id: -1 }'
  );

  console.log('  OK -> Found:', compoundIndex.name);

  // Find a real message to use as our cursor.
  const cursorMessage = await Message.findOne({ room: room._id })
    .sort({ createdAt: -1, _id: -1 })
    .lean();

  assert.ok(cursorMessage, 'No messages found in the javascript room');

  const cursorDate = cursorMessage.createdAt;
  const cursorId = cursorMessage._id;

  // Fetch messages older than the cursor.
  const filter = {
    room: room._id,
    $or: [
      { createdAt: { $lt: cursorDate } },
      {
        createdAt: cursorDate,
        _id: { $lt: cursorId },
      },
    ],
  };

  const query = Message.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(20)
    .hint(expectedKey);

  const explainResult = await query.explain('executionStats');

  const stages = printPlan(
    'Compound cursor query (forced to use compound index)',
    explainResult
  );

  assert.ok(
    stages.some((stage) => stage.stage === 'IXSCAN'),
    'Expected the compound pagination query to use an index scan'
  );

  assert.ok(
    stages.some((stage) => stage.indexName === compoundIndex.name),
    'Expected the query to use the compound pagination index'
  );

  // Run the query itself too, not just explain().
  const messages = await Message.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(20)
    .hint(expectedKey)
    .lean();

  // Every returned message must be strictly older than the cursor.
  for (const message of messages) {
    const isOlder =
      message.createdAt < cursorDate ||
      (
        message.createdAt.getTime() === cursorDate.getTime() &&
        message._id.toString() < cursorId.toString()
      );

    assert.ok(isOlder, 'Pagination returned a message at or after the cursor');
  }

  console.log('  OK -> Cursor filter and descending sort work');
  console.log('  OK -> Returned messages are strictly before the cursor');
}

async function verifyPrivateRoomAuthorization() {
  console.log('\n--- 2. Private room authorization ---');

  const room = await Room.findOne({ slug: 'core-team' }).lean();

  assert.ok(room, 'Missing #core-team room. Run the seed script first.');
  assert.equal(room.isPrivate, true, '#core-team must be a private room');

  const users = await User.find()
    .select('_id username')
    .lean();

  assert.ok(users.length > 0, 'No users found. Run the seed script first.');

  let member = null;
  let nonMember = null;

  // Find one actual member and one actual non-member.
  for (const user of users) {
    const membership = await RoomMember.exists({
      room: room._id,
      user: user._id,
    });

    if (membership && !member) member = user;
    if (!membership && !nonMember) nonMember = user;

    if (member && nonMember) break;
  }

  assert.ok(member, 'No member found in #core-team');
  assert.ok(nonMember, 'No non-member found for testing');

  console.log(`  Test member    : ${member.username}`);
  console.log(`  Test non-member: ${nonMember.username}`);

  // A legitimate member should be allowed.
  await ensureRoomAccess(room, member._id);

  console.log('  OK -> A room member is allowed');

  // A non-member must receive a 403 error.
  await assert.rejects(
    () => ensureRoomAccess(room, nonMember._id),
    (error) => {
      return (
        error.statusCode === 403 &&
        error.code === 'ROOM_ACCESS_DENIED'
      );
    },
    'A non-member was incorrectly allowed into #core-team'
  );

  console.log('  OK -> A non-member is denied access');

  // An unauthenticated user must receive a 401 error.
  await assert.rejects(
    () => ensureRoomAccess(room, null),
    (error) => {
      return (
        error.statusCode === 401 &&
        error.code === 'AUTH_REQUIRED'
      );
    },
    'An unauthenticated user was incorrectly allowed into #core-team'
  );

  console.log('  OK -> An unauthenticated user is denied access');
}

async function main() {
  await connectDB();

  await Promise.all([
    User.init(),
    Room.init(),
    Message.init(),
    RoomMember.init(),
  ]);

  const javascriptRoom = await Room.findOne({
    slug: 'javascript',
  }).lean();

  assert.ok(
    javascriptRoom,
    'Missing javascript room. Run the seed script first.'
  );

  await verifyCompoundPaginationIndex(javascriptRoom);
  await verifyPrivateRoomAuthorization();

  console.log('\nAll verification checks passed.');
}

main()
  .catch((error) => {
    console.error('\nVerification failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDB();
  });