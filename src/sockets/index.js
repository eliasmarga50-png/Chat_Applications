
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

import { env } from '../config/env.js';
import { authenticate, scheduleSessionExpiry } from './authMiddleware.js';
import { registerChatHandlers } from './chatHandlers.js';

export async function createSocketServer(httpServer) {
  let redisClients = null;

  if (env.REDIS_URL) {
    const pubClient = createClient({
      url: env.REDIS_URL,
    });

    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => {
      console.error('[redis] publisher error:', err.message);
    });

    subClient.on('error', (err) => {
      console.error('[redis] subscriber error:', err.message);
    });

    await Promise.all([
      pubClient.connect(),
      subClient.connect(),
    ]);

    redisClients = {
      pubClient,
      subClient,
    };
  } else if (env.REQUIRE_REDIS_ADAPTER) {
    throw new Error(
      'REDIS_URL is required when REQUIRE_REDIS_ADAPTER=true'
    );
  }

  const io = new Server(httpServer, {
    cors: {
      origin: env.CORS_ORIGINS,
      methods: ['GET', 'POST'],
    },

    maxHttpBufferSize: 100_000,

    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
  });

  if (redisClients) {
    io.adapter(
      createAdapter(
        redisClients.pubClient,
        redisClients.subClient
      )
    );

    console.log(
      '[socket] Redis adapter enabled (cross-instance broadcasts)'
    );
  } else {
    console.warn(
      '[socket] Redis adapter disabled; broadcasts are process-local'
    );
  }

  io.engine.on('connection_error', (err) => {
    console.warn(
      `[socket] transport rejected: ${err.code} ${err.message}`
    );
  });

  io.use(authenticate);

  io.on('connection', (socket) => {
    console.log(
      `[socket] connected ${socket.data.user.username} (${socket.id})`
    );

    scheduleSessionExpiry(socket);

    registerChatHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(
        `[socket] disconnected ${socket.data.user.username} (${reason})`
      );
    });
  });

  io.on('close', async () => {
    if (redisClients) {
      await Promise.allSettled([
        redisClients.pubClient.quit(),
        redisClients.subClient.quit(),
      ]);
    }
  });

  return io;
}
