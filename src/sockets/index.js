import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { devIdentity } from './devIdentity.js';
import { registerChatHandlers } from './chatHandlers.js';

export function createSocketServer(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.CORS_ORIGINS, methods: ['GET', 'POST'] },
    maxHttpBufferSize: 100_000, // 100 KB per message; big payloads go through streams in Step 5
    pingInterval: 25_000,       // server pings every 25s ...
    pingTimeout: 20_000,        // ... and drops the socket if no pong within 20s
    connectTimeout: 10_000,     // handshake (incl. our middleware) must finish in 10s
  });

  // Fires for failures *below* Socket.io (bad transport, bad origin, etc.).
  io.engine.on('connection_error', (err) => {
    console.warn(`[socket] transport rejected: ${err.code} ${err.message}`);
  });

  io.use(devIdentity); // Step 4 swaps this for JWT auth

  io.on('connection', (socket) => {
    console.log(`[socket] connected    ${socket.data.user.username} (${socket.id})`);

    registerChatHandlers(io, socket);

    socket.on('disconnect', (reason) => {
      console.log(`[socket] disconnected ${socket.data.user.username} (${reason})`);
    });
  });

  return io;
}