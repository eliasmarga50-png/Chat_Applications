// Code-execution worker (Step 8).
//
// This file is the entrypoint of a short-lived CHILD PROCESS. It is spawned by
// src/services/codeExecution.service.js with:
//   - Node's permission model (no fs / child_process / worker / addon access)
//   - an empty environment (no JWT_SECRET, no MONGODB_URI)
//   - a capped heap and --disallow-code-generation-from-strings
// and runs the snippet inside a locked-down `vm` context.
//
// Protocol: JSON on stdin  -> { code, timeoutMs }
//           one JSON line on stdout -> { status, stdout, stderr, error, truncated }

import vm from 'node:vm';

const MAX_STDIN_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 16 * 1024; // stdout + stderr combined
const MAX_ERROR_CHARS = 1024;

// ---------------------------------------------------------------------------
// Runs INSIDE the vm context. It defines `console` using only context-realm
// objects, so no host-realm function (and no host `Function` constructor) is
// ever reachable from user code. It returns two closures to the host; user
// code cannot reach them because they are never attached to the global object.
// ---------------------------------------------------------------------------
const BOOTSTRAP = `(function () {
  'use strict';
  const MAX = ${MAX_OUTPUT_CHARS};
  const MAX_ERR = ${MAX_ERROR_CHARS};

  // Capture primordials now so user code cannot swap them out later.
  const toStr = String;
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const arrayFrom = Array.from;
  const isFinite_ = Number.isFinite;

  let out = '';
  let err = '';
  let used = 0;
  let truncated = false;

  function fmt(v) {
    switch (typeof v) {
      case 'string': return v;
      case 'undefined': return 'undefined';
      case 'bigint': return toStr(v) + 'n';
      case 'symbol': return v.toString();
      case 'function': return '[Function' + (v.name ? ': ' + v.name : ' (anonymous)') + ']';
      case 'object': break;
      default: return toStr(v);
    }
    if (v === null) return 'null';
    if (v instanceof Error) return toStr(v.stack || (v.name + ': ' + v.message));

    const stack = [];
    function replacer(key, value) {
      if (typeof value === 'bigint') return toStr(value) + 'n';
      if (typeof value === 'function') return '[Function]';
      if (typeof value === 'symbol') return value.toString();
      if (value instanceof Map) value = { ['Map(' + value.size + ')']: arrayFrom(value) };
      else if (value instanceof Set) value = { ['Set(' + value.size + ')']: arrayFrom(value) };
      if (value !== null && typeof value === 'object') {
        while (stack.length > 0 && stack[stack.length - 1] !== this) stack.pop();
        if (stack.indexOf(value) !== -1) return '[Circular]';
        stack.push(value);
      }
      return value;
    }
    try {
      const s = stringify(v, replacer, 2);
      return typeof s === 'string' ? s : toStr(v);
    } catch (e) {
      return '[Unserializable]';
    }
  }

  function write(toErr, args) {
    if (truncated) return;
    let line = '';
    for (let i = 0; i < args.length; i++) {
      if (i > 0) line += ' ';
      line += fmt(args[i]);
    }
    line += '\\n';
    if (used + line.length > MAX) {
      line = line.slice(0, MAX - used);
      truncated = true;
    }
    used += line.length;
    if (toErr) err += line; else out += line;
  }

  const log = function log(...a) { write(false, a); };
  const warn = function warn(...a) { write(true, a); };
  const consoleObj = Object.freeze({
    log, info: log, debug: log, warn, error: warn, trace: warn,
  });
  Object.defineProperty(globalThis, 'console', {
    value: consoleObj, writable: false, configurable: false, enumerable: false,
  });

  function snapshot() {
    return [out, err, truncated];
  }

  // Reads an arbitrary thrown value and returns a short string. Only lines
  // that point into the user's snippet are kept from the stack, so host file
  // paths and Node internals never leak.
  function describeError(e) {
    try {
      if ((typeof e === 'object' && e !== null) || typeof e === 'function') {
        const name = toStr(e.name || 'Error');
        const message = toStr(e.message === undefined ? '' : e.message);
        let text = name + (message ? ': ' + message : '');
        const stack = typeof e.stack === 'string' ? e.stack.split('\\n') : [];
        for (let i = 0; i < stack.length && i < 20; i++) {
          if (stack[i].indexOf('snippet.js') !== -1) { text += '\\n' + stack[i].trim(); break; }
        }
        return text.slice(0, MAX_ERR);
      }
      return ('Uncaught ' + toStr(e)).slice(0, MAX_ERR);
    } catch (_) {
      return 'Uncaught exception';
    }
  }

  return [snapshot, describeError];
})()`;

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

function respond(result, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(exitCode));
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error('input too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch {
    return respond({ status: 'error', stdout: '', stderr: '', error: 'Invalid worker input', truncated: false });
  }

  const code = typeof request?.code === 'string' ? request.code : '';
  const timeoutMs = Number.isInteger(request?.timeoutMs) && request.timeoutMs > 0
    ? Math.min(request.timeoutMs, 10_000)
    : 2_000;

  // Null-prototype global, string/wasm code generation disabled, and
  // microtasks drained inside evaluate() so `timeout` also covers Promise loops.
  const sandbox = Object.create(null);
  const context = vm.createContext(sandbox, {
    name: 'snippet',
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });

  const [snapshot, describeError] = vm.runInContext(BOOTSTRAP, context, { timeout: 1_000 });

  let script;
  try {
    script = new vm.Script(code, { filename: 'snippet.js' });
  } catch (err) {
    // Compile errors are host-realm SyntaxErrors; reading .message is safe.
    return respond({
      status: 'error',
      stdout: '',
      stderr: '',
      error: `SyntaxError: ${String(err?.message ?? 'invalid syntax').slice(0, MAX_ERROR_CHARS)}`,
      truncated: false,
    });
  }

  let status = 'ok';
  let error = null;
  let rejection = null;

  // Errors from un-awaited promises surface after evaluate() returns.
  process.on('unhandledRejection', (reason) => {
    rejection ??= describeError(reason);
  });

  try {
    script.runInContext(context, { timeout: timeoutMs, breakOnSigint: false });
  } catch (err) {
    if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      status = 'timeout';
      error = `Execution timed out after ${timeoutMs}ms`;
    } else {
      status = 'error';
      error = describeError(err);
    }
  }

  // Let the unhandledRejection event fire before we build the response.
  setImmediate(() => {
    if (status === 'ok' && rejection) {
      status = 'error';
      error = `Uncaught (in promise) ${rejection}`;
    }

    const [out, err, truncated] = snapshot();
    respond({
      status,
      stdout: typeof out === 'string' ? out.slice(0, MAX_OUTPUT_CHARS) : '',
      stderr: typeof err === 'string' ? err.slice(0, MAX_OUTPUT_CHARS) : '',
      error,
      truncated: truncated === true,
    });
  });
}

process.on('uncaughtException', () => {
  respond({ status: 'error', stdout: '', stderr: '', error: 'Uncaught exception', truncated: false }, 1);
});

main().catch(() => {
  respond({ status: 'error', stdout: '', stderr: '', error: 'Worker failure', truncated: false }, 1);
});