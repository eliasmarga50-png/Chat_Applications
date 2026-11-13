
# DevConnect Backend: Real-Time Developer Chat Engine

A production-oriented real-time chat backend built with Node.js, Express, Socket.IO, and MongoDB (Mongoose). It supports REST APIs, realtime rooms, JWT authentication, persistent messaging, secure content handling, and isolated code execution.

## Key Architecture

- Hybrid REST and Socket.IO communication.
- MongoDB persistence through Mongoose.
- Socket.IO rooms for chat channels.
- JWT authentication for realtime connections.
- Stream-driven file ingestion.
- Content sanitization.
- Isolated code execution workers.

## Sandboxed code execution

`POST /api/execute` runs JavaScript in an isolated child process.

## Horizontal Scaling (Step 9)

The backend supports:

- A single Node.js process.
- Multiple Node.js workers using the native Cluster module.
- Cross-worker and cross-server Socket.IO broadcasts through Redis.
- Shared MongoDB persistence across all workers.

### Start a single instance

```bash
npm start
```

### Start a clustered instance

```bash
npm run start:cluster
```

### Environment configuration

```env
REDIS_URL=redis://127.0.0.1:6379
REQUIRE_REDIS_ADAPTER=true
WEB_CONCURRENCY=4
```

### Architecture

```text
                   Load Balancer
                        |
            +-----------+-----------+
            |           |           |
         Worker A   Worker B    Worker C
            |           |           |
            +-----------+-----------+
                        |
                    Redis
                 Pub / Sub
                        |
                    MongoDB
                 Persistence
```

Every worker must use:

- The same MongoDB database.
- The same JWT secret.
- The same Redis server or Redis cluster.
- The same application configuration.

MongoDB remains the authoritative message store. Messages are persisted before being broadcast.

### Load balancing

Socket.IO polling transport requires sticky sessions when requests may reach different workers.

Configure session affinity in your load balancer, or use WebSocket-only transport where appropriate.

### Current limitations

The Redis adapter distributes Socket.IO broadcasts, but it does not automatically distribute custom in-memory application state.

The existing `realtimeState.js` service still manages presence and typing state locally. Therefore, online user counts and typing aggregates are not globally accurate across workers yet.

Redis-backed distributed presence is a separate implementation task.
