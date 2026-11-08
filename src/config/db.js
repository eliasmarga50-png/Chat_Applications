import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let listenersAttached = false;

function attachListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  const conn = mongoose.connection;
  conn.on('connected', () => console.log('[mongo] connected'));
  conn.on('disconnected', () => console.warn('[mongo] disconnected'));
  conn.on('reconnected', () => console.log('[mongo] reconnected'));
  // Without an 'error' listener, an emitted 'error' event THROWS
  // (EventEmitter semantics) and can crash the process.
  conn.on('error', (err) => console.error('[mongo] error:', err.message));
}

export async function connectDB({ retries = 5, baseDelayMs = 1000 } = {}) {
  attachListeners();

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(env.MONGODB_URI, {
        maxPoolSize: 10,                 // sockets in the pool
        serverSelectionTimeoutMS: 5000,  // give up finding a server after 5s
        socketTimeoutMS: 45000,
        autoIndex: !env.isProd,          // drop sockets idle on an op for 45s
      });
      return mongoose.connection;
    } catch (err) {
      console.error(`[mongo] connect attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) throw err;
      await sleep(baseDelayMs * 2 ** (attempt - 1)); // 1s, 2s, 4s, 8s...
    }
  }
}

export async function disconnectDB() {
  await mongoose.connection.close();
}