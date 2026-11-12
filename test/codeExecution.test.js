import test from 'node:test';
import assert from 'node:assert/strict';

import { runSnippet } from '../src/services/codeExecution.service.js';

// Requires env vars (run with: npm test) because the service reads src/config/env.js.

test('returns console output', async () => {
  const r = await runSnippet('console.log("hi", 1 + 1); console.error("oops");');
  assert.equal(r.status, 'ok');
  assert.equal(r.stdout, 'hi 2\n');
  assert.equal(r.stderr, 'oops\n');
});

test('formats objects, circular refs and bigint', async () => {
  const r = await runSnippet('const a = {n: 1}; a.self = a; console.log(a, 5n);');
  assert.equal(r.status, 'ok');
  assert.match(r.stdout, /\[Circular\]/);
  assert.match(r.stdout, /5n/);
});

test('supports promises / async functions', async () => {
  const r = await runSnippet('(async () => { await null; console.log("async ok"); })();');
  assert.equal(r.stdout, 'async ok\n');
});

test('reports runtime errors without leaking host paths', async () => {
  const r = await runSnippet('throw new TypeError("bad");');
  assert.equal(r.status, 'error');
  assert.match(r.error, /TypeError: bad/);
  assert.doesNotMatch(r.error, /workers|node_modules|node:/);
});

test('reports syntax errors', async () => {
  const r = await runSnippet('let = ;');
  assert.equal(r.status, 'error');
  assert.match(r.error, /SyntaxError/);
});

test('kills infinite loops', async () => {
  const r = await runSnippet('while (true) {}');
  assert.equal(r.status, 'timeout');
});

test('kills infinite microtask loops', async () => {
  const r = await runSnippet('const f = () => Promise.resolve().then(f); f();');
  // Either limit may trip first: the loop allocates promises until the time or heap cap is hit.
  assert.ok(['timeout', 'memory_limit'].includes(r.status), r.status);
});

test('truncates huge output', async () => {
  const r = await runSnippet('for (let i = 0; i < 1e6; i++) console.log("x".repeat(100));');
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 16 * 1024);
});

test('survives memory exhaustion', async () => {
  const r = await runSnippet('const a = []; while (true) a.push(new Array(1e6).fill("x"));');
  assert.ok(['memory_limit', 'timeout', 'crashed'].includes(r.status), r.status);
});

test('has no access to node globals', async () => {
  const r = await runSnippet(
    'console.log(typeof require, typeof process, typeof Buffer, typeof setTimeout, typeof fetch)'
  );
  assert.equal(r.stdout, 'undefined undefined undefined undefined undefined\n');
});

test('cannot escape through constructors', async () => {
  const attempts = [
    'console.log(console.log.constructor("return process")())',
    'console.log(this.constructor.constructor("return process")())',
    'console.log((function(){}).constructor("return process")())',
    'console.log(Object.getPrototypeOf(async function(){}).constructor("return process")())',
    'try { null.x } catch (e) { console.log(e.constructor.constructor("return process")()) }',
    'console.log(eval("1+1"))',
    'console.log(new Function("return 1")())',
  ];
  for (const code of attempts) {
    const r = await runSnippet(code);
    assert.equal(r.status, 'error', code);
    assert.equal(r.stdout, '', code);
  }
});

test('cannot import modules', async () => {
  const r = await runSnippet('import("node:fs").then(m => console.log(Object.keys(m))).catch(e => console.log("blocked"));');
  assert.doesNotMatch(r.stdout, /readFile/);
});

test('does not receive server secrets', async () => {
  const r = await runSnippet('console.log(typeof process === "undefined" ? "none" : process.env.JWT_SECRET)');
  assert.equal(r.stdout, 'none\n');
});

test('refuses a second snippet from the same user while one runs', async () => {
  const first = runSnippet('while (true) {}', { ownerId: 'u1' });
  await assert.rejects(runSnippet('1', { ownerId: 'u1' }), { code: 'EXECUTION_IN_PROGRESS' });
  await first;
});