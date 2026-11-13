
import { createClient } from 'redis';
import { env } from './env.js';

let commandClient;
let pubClient;
let subClient;
let initialization;

function attachErrorLogging(client, label) {
  client.on('error', (error) => {
    console.error(`[redis] ${label} error:`, error.message);
  });
}

export async function initializeRedis() {
  if (initialization) return initialization;

  initialization = (async () => {
    if (!env.REDIS_URL) {
      if (env.REQUIRE_REDIS_ADAPTER) {
        throw new Error('REDIS_URL is required when REQUIRE_REDIS_ADAPTER=true');
      }
      return null;
    }

    commandClient = createClient({ url: env.REDIS_URL });
    pubClient = createClient({ url: env.REDIS_URL });
    subClient = pubClient.duplicate();

    attachErrorLogging(commandClient, 'command');
    attachErrorLogging(pubClient, 'publisher');
    attachErrorLogging(subClient, 'subscriber');

    await Promise.all([
      commandClient.connect(),
      pubClient.connect(),
      subClient.connect(),
    ]);

    return { commandClient, pubClient, subClient };
  })();

  try {
    return await initialization;
  } catch (error) {
    initialization = undefined;
    await closeRedis();
    throw error;
  }
}

export function getRedisClient() {
  if (!commandClient?.isReady) {
    const error = new Error('Shared Redis service is unavailable');
    error.code = 'REDIS_UNAVAILABLE';
    throw error;
  }
  return commandClient;
}

export function getSocketRedisClients() {
  if (!pubClient?.isReady || !subClient?.isReady) return null;
  return { pubClient, subClient };
}

export async function closeRedis() {
  const clients = [commandClient, pubClient, subClient].filter(Boolean);
  commandClient = undefined;
  pubClient = undefined;
  subClient = undefined;
  initialization = undefined;
  await Promise.allSettled(clients.map((client) => (
    client.isOpen ? client.quit() : Promise.resolve()
  )));
}
