
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';

import { createRealtimeStore } from '../src/services/realtimeStore.js';

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

test(
  'Redis shares presence, room membership and typing state across sockets',
  { skip: !REDIS_TEST_URL && 'Set REDIS_TEST_URL to run this integration test' },
  async () => {
    const clientA = createClient({ url: REDIS_TEST_URL });
    const clientB = createClient({ url: REDIS_TEST_URL });

    clientA.on('error', (error) => {
      console.error('[test redis A]', error.message);
    });

    clientB.on('error', (error) => {
      console.error('[test redis B]', error.message);
    });

    const storeA = createRealtimeStore(() => clientA);
    const storeB = createRealtimeStore(() => clientB);

    const userId = `test-user-${randomUUID()}`;
    const roomSlug = `test-room-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const socketA = `test-socket-${randomUUID()}`;
    const socketB = `test-socket-${randomUUID()}`;

    let connectedA = false;
    let connectedB = false;

    try {
      await Promise.all([
        clientA.connect(),
        clientB.connect(),
      ]);

      connectedA = true;
      connectedB = true;

      // First socket makes the user online.
      const firstRegistration = await storeA.registerSocket(userId, socketA);

      assert.equal(firstRegistration.isNewOnlineUser, true);
      assert.equal(await storeA.isUserOnline(userId), true);

      // Second socket belongs to the same user. It must not create
      // a second online user.
      const secondRegistration = await storeB.registerSocket(userId, socketB);

      assert.equal(secondRegistration.isNewOnlineUser, false);
      assert.equal(await storeB.isUserOnline(userId), true);

      // Both sockets join the same room.
      const firstJoin = await storeA.joinRoom(roomSlug, userId, socketA);
      const secondJoin = await storeB.joinRoom(roomSlug, userId, socketB);

      assert.equal(firstJoin.isFirstSocket, true);
      assert.equal(secondJoin.isFirstSocket, false);

      // Typing should become active only on the first transition
      // from zero typing sockets to one.
      const firstTyping = await storeA.setTyping(
        roomSlug,
        userId,
        socketA,
        true,
      );

      assert.deepEqual(firstTyping, {
        changed: true,
        isTyping: true,
      });

      const secondTyping = await storeB.setTyping(
        roomSlug,
        userId,
        socketB,
        true,
      );

      assert.deepEqual(secondTyping, {
        changed: false,
        isTyping: true,
      });

      assert.deepEqual(
        await storeB.getTypingUsers(roomSlug),
        [userId],
      );

      // Stopping typing on one socket must not mark the user as
      // stopped while the other socket is still typing.
      const firstStop = await storeA.setTyping(
        roomSlug,
        userId,
        socketA,
        false,
      );

      assert.deepEqual(firstStop, {
        changed: false,
        isTyping: true,
      });

      // Re-enable typing on socket A so disconnect cleanup can
      // verify that it removes only that socket's state.
      await storeA.setTyping(roomSlug, userId, socketA, true);

      const cleanupA = await storeA.unregisterSocket(socketA);

      assert.equal(cleanupA.isOfflineUser, false);
      assert.deepEqual(cleanupA.leftRooms, []);
      assert.deepEqual(cleanupA.stoppedTyping, []);
      assert.equal(await storeB.isUserOnline(userId), true);

      // The final socket disconnects. The user should now be offline,
      // and their room and typing state should be cleaned up.
      const cleanupB = await storeB.unregisterSocket(socketB);

      assert.equal(cleanupB.userId, userId);
      assert.equal(cleanupB.isOfflineUser, true);
      assert.deepEqual(cleanupB.leftRooms, [roomSlug]);
      assert.deepEqual(cleanupB.stoppedTyping, [
        { roomSlug, userId },
      ]);

      assert.equal(await storeA.isUserOnline(userId), false);
      assert.deepEqual(await storeA.getTypingUsers(roomSlug), []);
    } finally {
      // Best-effort cleanup if an assertion fails midway.
      if (connectedA && clientA.isReady) {
        await storeA.unregisterSocket(socketA).catch(() => {});
      }

      if (connectedB && clientB.isReady) {
        await storeB.unregisterSocket(socketB).catch(() => {});
      }

      await Promise.allSettled([
        connectedA && clientA.isOpen ? clientA.quit() : Promise.resolve(),
        connectedB && clientB.isOpen ? clientB.quit() : Promise.resolve(),
      ]);
    }
  },
);
