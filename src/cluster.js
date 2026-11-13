
import cluster from 'node:cluster';
import os from 'node:os';
import process from 'node:process';
import { loadEnvFile } from 'node:process';

// Load .env in the primary BEFORE forking workers.
// Workers inherit the primary process environment.
try {
  loadEnvFile('.env');
} catch (error) {
  if (error.code !== 'ENOENT') {
    throw error;
  }
}

const configuredWorkers = Number.parseInt(
  process.env.WEB_CONCURRENCY ?? '',
  10
);

const workerCount =
  Number.isInteger(configuredWorkers) && configuredWorkers > 0
    ? configuredWorkers
    : os.availableParallelism();

if (cluster.isPrimary) {
  console.log(
    `[cluster] primary ${process.pid}; starting ${workerCount} workers`
  );

  let shuttingDown = false;

  for (let i = 0; i < workerCount; i++) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(
      `[cluster] worker ${worker.process.pid} online`
    );
  });

  cluster.on('exit', (worker, code, signal) => {
    console.warn(
      `[cluster] worker ${worker.process.pid} exited ` +
      `(code=${code}, signal=${signal})`
    );

    if (shuttingDown) return;

    if (worker.exitedAfterDisconnect) {
      return;
    }

    // Avoid endlessly restarting workers that repeatedly fail startup.
    if (code === 1) {
      console.error(
        '[cluster] worker exited during startup. ' +
        'Check configuration before restarting.'
      );

      shuttingDown = true;

      for (const current of Object.values(cluster.workers)) {
        current?.kill();
      }

      process.exitCode = 1;
      return;
    }

    console.log('[cluster] starting replacement worker');
    cluster.fork();
  });

  function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;

    console.log(
      `[cluster] primary received ${signal}; stopping workers`
    );

    for (const worker of Object.values(cluster.workers)) {
      worker?.process.kill(signal);
    }

    cluster.disconnect(() => {
      process.exit(0);
    });

    setTimeout(() => {
      for (const worker of Object.values(cluster.workers)) {
        worker?.kill();
      }

      process.exit(1);
    }, 12_000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} else {
  await import('./server.js');
}
