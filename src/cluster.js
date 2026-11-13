
import cluster from 'node:cluster';
import os from 'node:os';
import process from 'node:process';

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

  for (let i = 0; i < workerCount; i++) {
    cluster.fork();
  }

  cluster.on('online', (worker) => {
    console.log(
      `[cluster] worker ${worker.process.pid} online`
    );
  });

  let shuttingDown = false;

  cluster.on('exit', (worker, code, signal) => {
    console.warn(
      `[cluster] worker ${worker.process.pid} exited ` +
      `(code=${code}, signal=${signal})`
    );

    if (!shuttingDown) {
      console.log('[cluster] starting replacement worker');
      cluster.fork();
    }
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

    const deadline = setTimeout(() => {
      console.error('[cluster] shutdown timeout');

      for (const worker of Object.values(cluster.workers)) {
        worker?.kill();
      }

      process.exit(1);
    }, 12_000);

    deadline.unref();

    cluster.disconnect(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
} else {
  // Every worker starts its own application instance.
  await import('./server.js');
}
