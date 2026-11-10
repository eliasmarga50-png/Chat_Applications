import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { authenticate, scheduleSessionExpiry } from './authMiddleware.js';
import { registerChatHandlers } from './chatHandlers.js';

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 100_000, // 100 KB per message; big payloads go through streams in Step 5
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,     // handshake (incl. our DB lookup) must finish in 10s
  });

  io.engine.on('connection_error', (err) => {
    console.warn(`[socket] transport rejected: ${err.code} ${err.message}`);
  });

  // Runs once per connection attempt, BEFORE the 'connection' event.
  // Anything that calls next(err) never reaches registerChatHandlers.
  io.use(authenticate);

  io.on('connection', (socket) => {
    console.log(`[socket] connected    ${socket.data.user.username} (${socket.id})`);

    scheduleSessionExpiry(socket);
    registerChatHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(`[socket] disconnected ${socket.data.user.username} (${reason})`);
    });
  });

  return io;
}