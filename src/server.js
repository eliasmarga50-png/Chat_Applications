import http from 'node:http';
import { env } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { createApp } from './app.js';

let server;
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
    if (server) {
      server.closeIdleConnections?.();
      // Stop accepting new connections; resolves when in-flight requests finish.
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
  await connectDB(); // don't accept traffic until the DB is ready

  // http.createServer (rather than app.listen) gives us the raw server
  // instance that Socket.io will attach to in Step 3.
  server = http.createServer(createApp());
  server.listen(env.PORT, () => {
    console.log(`[http] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });
}

main().catch((err) => {
  console.error('[fatal] failed to start:', err);
  process.exit(1);
});