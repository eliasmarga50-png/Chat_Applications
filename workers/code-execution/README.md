# Code execution worker

`worker.js` is the entrypoint of a short-lived child process spawned by
`src/services/codeExecution.service.js` for every `POST /api/execute` request.

## Isolation layers

1. **Separate process.** A crash, OOM or infinite loop never touches the chat
   server, Socket.io or the MongoDB connection.
2. **Node permission model** (`--permission`). No file-system access except
   reading this one file; no `child_process`, `worker_threads` or native addons.
3. **Empty environment.** `JWT_SECRET`, `MONGODB_URI` etc. are never passed.
4. **Resource limits.** `--max-old-space-size` (heap), vm `timeout` (CPU loops
   and Promise loops), a wall-clock `SIGKILL` from the parent, and caps on
   output size and code size.
5. **Locked-down `vm` context.** Null-prototype global, no `require`,
   `process`, `Buffer`, timers or `fetch`; `console` is built inside the
   context; string/wasm code generation is disabled (`eval`, `new Function`).

## Honest limits

`vm` is **not** a security boundary by itself; the process + permission model
is what contains the code. Node's permission model does not restrict the
network or native memory (e.g. huge `ArrayBuffer`s). For a public deployment,
also run the server in a container with no outbound network and cgroup
memory/CPU/pids limits.

## Protocol

stdin: `{ "code": string, "timeoutMs": number }`
stdout: one JSON line `{ status, stdout, stderr, error, truncated }`
where `status` is `ok`, `error` or `timeout`.