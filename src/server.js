import http from 'node:http';
import { initializeStorage } from './config/storage.js';
import { env } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { createApp } from './app.js';
import { createSocketServer } from './sockets/index.js';

let server;
let io;
let shuttingDown = false;

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${reason}`);

  // Hard deadline: if cleanup hangs, force exit. unref() so this timer
  // alone never keeps the event loop alive.
  setTimeout(() => {
    console.error('[shutdown] forced exit after timeout');
    process.exit(1);
  }, 10_000).unref();

  try {
    if (io) {
      // Disconnects every socket, then closes the underlying HTTP server too.
      // WebSockets are long-lived, so server.close() alone would wait forever.
      await new Promise((resolve) => io.close(resolve));
    } else if (server) {
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    await disconnectDB();
    console.log('[shutdown] clean');
  } catch (err) {
    console.error('[shutdown] error during cleanup:', err);
    exitCode = 1;
  } finally {
    process.exit(exitCode);
  }
}

// Safety nets: log, then exit gracefully so a process manager restarts us.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  shutdown('uncaughtException', 1);
});

// Signals from Ctrl+C (SIGINT) and from Docker/PM2/systemd (SIGTERM)
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  await connectDB();

  // Ensure upload directory exists before accepting requests.
  await initializeStorage();

  server = http.createServer(createApp());
  io = createSocketServer(server);

  server.listen(env.PORT, () => {
    console.log(
      `[http] listening on http://localhost:${env.PORT}`
    );

    console.log(
      `[socket] Socket.io attached at /socket.io/`
    );
  });
}

main().catch((err) => {
  console.error('[fatal] failed to start:', err);
  process.exit(1);
});