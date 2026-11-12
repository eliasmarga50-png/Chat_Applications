import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { env } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

const WORKER_PATH = fileURLToPath(
  new URL('../../workers/code-execution/worker.js', import.meta.url)
);

const MAX_RESULT_BYTES = 64 * 1024; // worker output is already capped; this is a backstop
const MAX_STDERR_BYTES = 4 * 1024;  // diagnostics for server logs only, never returned
const KILL_GRACE_MS = 1_500;        // process start-up + result serialization

const STATUSES = new Set(['ok', 'error', 'timeout']);

let active = 0;
const activeOwners = new Set();

// Node renamed the flag in v22.13. Fail closed if neither exists: running
// untrusted code without the permission model is not acceptable.
function permissionFlag() {
  const flags = process.allowedNodeEnvironmentFlags;
  if (flags.has('--permission')) return '--permission';
  if (flags.has('--experimental-permission')) return '--experimental-permission';
  throw new AppError(
    'Code execution is unavailable on this Node.js version',
    503,
    'EXECUTOR_UNAVAILABLE'
  );
}

// Nothing from the server's environment (JWT_SECRET, MONGODB_URI...) is passed on.
function childEnv() {
  return process.platform === 'win32' && process.env.SystemRoot
    ? { SystemRoot: process.env.SystemRoot }
    : {};
}

function cap(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function parseWorkerOutput(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString('utf8').trim());
    if (!STATUSES.has(parsed?.status)) return null;
    return {
      status: parsed.status,
      stdout: cap(parsed.stdout, 16 * 1024),
      stderr: cap(parsed.stderr, 16 * 1024),
      error: typeof parsed.error === 'string' ? cap(parsed.error, 1024) : null,
      truncated: parsed.truncated === true,
    };
  } catch {
    return null;
  }
}

function emptyResult(status, error) {
  return { status, stdout: '', stderr: '', error, truncated: false };
}

function execute(code) {
  const timeoutMs = env.EXEC_TIMEOUT_MS;
  const flag = permissionFlag();

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();

    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${env.EXEC_MEMORY_MB}`,
        '--disallow-code-generation-from-strings',
        flag,
        `--allow-fs-read=${WORKER_PATH}`,
        WORKER_PATH,
      ],
      {
        env: childEnv(),
        cwd: os.tmpdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
    );

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killedFor = null;

    const kill = (reason) => {
      if (killedFor) return;
      killedFor = reason;
      child.kill('SIGKILL');
    };

    // Hard wall-clock limit enforced from OUTSIDE the child, so it still works
    // if the child is wedged in a way the in-process vm timeout cannot catch.
    const wallTimer = setTimeout(() => kill('timeout'), timeoutMs + KILL_GRACE_MS);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RESULT_BYTES) return kill('output_limit');
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    child.stdin.on('error', () => {}); // child may die before reading (EPIPE)

    child.on('error', (err) => {
      clearTimeout(wallTimer);
      console.error('[exec] failed to spawn worker:', err.message);
      reject(new AppError('Code execution is unavailable', 503, 'EXECUTOR_UNAVAILABLE'));
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(wallTimer);
      const durationMs = Math.round(performance.now() - startedAt);
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');

      let result;
      if (killedFor === 'timeout') {
        result = emptyResult('timeout', `Execution timed out after ${timeoutMs}ms`);
      } else if (killedFor === 'output_limit') {
        result = emptyResult('error', 'Execution produced too much output');
      } else {
        result = parseWorkerOutput(Buffer.concat(stdoutChunks));
        if (!result) {
          const oom = /heap out of memory|allocation failed/i.test(stderrText) || signal === 'SIGABRT';
          result = oom
            ? emptyResult('memory_limit', `Execution exceeded the ${env.EXEC_MEMORY_MB}MB memory limit`)
            : emptyResult('crashed', 'The code runner crashed');
          console.warn(`[exec] worker ended without a result (code=${exitCode}, signal=${signal})`);
        }
      }

      resolve({ ...result, durationMs });
    });

    child.stdin.end(JSON.stringify({ code, timeoutMs }));
  });
}

/**
 * Run a JavaScript snippet in an isolated child process.
 * Resolves with { status, stdout, stderr, error, truncated, durationMs }.
 * Rejects only with AppError when the request could not be run at all.
 */
export async function runSnippet(code, { ownerId } = {}) {
  if (ownerId && activeOwners.has(ownerId)) {
    throw new AppError('You already have a snippet running', 429, 'EXECUTION_IN_PROGRESS');
  }
  if (active >= env.EXEC_MAX_CONCURRENT) {
    throw new AppError('Code runner is busy, try again shortly', 503, 'EXECUTOR_BUSY');
  }

  active += 1;
  if (ownerId) activeOwners.add(ownerId);

  try {
    return await execute(code);
  } finally {
    active -= 1;
    if (ownerId) activeOwners.delete(ownerId);
  }
}