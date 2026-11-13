
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';

import { env } from '../config/env.js';
import { getSocketRedisClients } from '../config/redis.js';
import { authenticate, scheduleSessionExpiry } from './authMiddleware.js';
import { registerChatHandlers } from './chatHandlers.js';

export async function createSocketServer(httpServer) {
  const redisClients = getSocketRedisClients();
  if (!redisClients && env.REQUIRE_REDIS_ADAPTER) {
    throw new Error('Redis clients are required when REQUIRE_REDIS_ADAPTER=true');
  }

  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 100_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
  });

  if (redisClients) {
    io.adapter(createAdapter(redisClients.pubClient, redisClients.subClient));
    console.log('[socket] Redis adapter enabled (cross-worker broadcasts)');
  } else {
    console.warn('[socket] Redis adapter disabled; cross-worker broadcasts unavailable');
  }

  io.engine.on('connection_error', (err) => {
    console.warn(`[socket] transport rejected: ${err.code} ${err.message}`);
  });

  io.use(authenticate);

  io.on('connection', (socket) => {
    socket.emit('server:instance', { pid: process.pid });
    console.log(`[socket] connected ${socket.data.user.username} (${socket.id})`);
    scheduleSessionExpiry(socket);

    registerChatHandlers(io, socket).catch((error) => {
      console.error('[socket] failed to initialize connection state:', error);
      socket.disconnect(true);
    });
  });

  return io;
}
