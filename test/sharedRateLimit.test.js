
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';

import { consumeRateLimitWithClient } from '../src/middleware/rateLimit.js';

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

test(
  'rate limits are shared between independent Redis clients',
  { skip: !REDIS_TEST_URL && 'Set REDIS_TEST_URL to run this integration test' },
  async () => {
    const clientA = createClient({ url: REDIS_TEST_URL });
    const clientB = createClient({ url: REDIS_TEST_URL });

    clientA.on('error', (error) => {
      console.error('[rate-limit test Redis A]', error.message);
    });

    clientB.on('error', (error) => {
      console.error('[rate-limit test Redis B]', error.message);
    });

    const testKey = `integration-test-${randomUUID()}`;
    const redisKey = `devchat:rate:${testKey}`;

    let connectedA = false;
    let connectedB = false;

    try {
      await Promise.all([
        clientA.connect(),
        clientB.connect(),
      ]);

      connectedA = true;
      connectedB = true;

      const options = {
        key: testKey,
        windowMs: 10_000,
        max: 2,
      };

      // First request goes through client A.
      const first = await consumeRateLimitWithClient(clientA, options);

      assert.deepEqual(
        {
          allowed: first.allowed,
          count: first.count,
        },
        {
          allowed: true,
          count: 1,
        },
      );

      // Second request goes through a different Redis connection.
      const second = await consumeRateLimitWithClient(clientB, options);

      assert.deepEqual(
        {
          allowed: second.allowed,
          count: second.count,
        },
        {
          allowed: true,
          count: 2,
        },
      );

      // The shared limit has been reached.
      const third = await consumeRateLimitWithClient(clientA, options);

      assert.deepEqual(
        {
          allowed: third.allowed,
          count: third.count,
        },
        {
          allowed: false,
          count: 3,
        },
      );

      assert.ok(third.retryAfterMs > 0);

      // A different key must have an independent counter.
      const independent = await consumeRateLimitWithClient(clientB, {
        ...options,
        key: `${testKey}-independent`,
      });

      assert.equal(independent.allowed, true);
      assert.equal(independent.count, 1);
    } finally {
      // Remove only the keys created by this test.
      if (connectedA && clientA.isReady) {
        await clientA.del(redisKey).catch(() => {});
        await clientA.del(`${redisKey}-independent`).catch(() => {});
      }

      await Promise.allSettled([
        connectedA && clientA.isOpen ? clientA.quit() : Promise.resolve(),
        connectedB && clientB.isOpen ? clientB.quit() : Promise.resolve(),
      ]);
    }
  },
);
