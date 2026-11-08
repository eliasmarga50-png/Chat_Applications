# DevConnect Backend: Real-Time Developer Chat Engine

A production-ready, highly scalable, and secure real-time chat application backend specifically engineered for developer communities. This backend forms the core of a MERN-stack architecture, utilizing **Node.js**, **Express**, **Socket.io**, and **MongoDB (Mongoose)** to deliver robust communication streams, sandboxed code execution, and high-performance data handling.

The project is built incrementally to dive deep into underlying Node.js core principles—including the Event Loop, asynchronous flow control, Streams, child processes, and cluster-based horizontal scaling.

## 🚀 Key Architecture & Features

- **Hybrid Communication Architecture:** Combines lightweight Express REST endpoints for static operations (user management, channel listings) with persistent Socket.io connections for low-latency, real-time message broadcasting.
- **Asynchronous Data Layer:** Powered by MongoDB and Mongoose, featuring optimal indexing configurations for swift chronological message retrieval and channel filtering.
- **Robust Event-Driven Rooms:** Implements custom namespaces and rooms using Node’s native `EventEmitter` philosophy to handle isolated developer channels (e.g., `#javascript`, `#python`).
- **Secure Token-Based Handshakes:** Custom Socket.io connection middleware that validates JSON Web Tokens (JWT) directly during the HTTP handshake phase.
- **Stream-Driven Ingestion:** Utilizes Node.js Duplex/Transform streams to handle raw source code uploads and log file distributions without overwhelming server memory.
- **Dual-Layer State Management:** Leverages persistent disk-bound structures for archival records combined with rapid in-memory tracking for fleeting states like typing indicators and online user counts.
- **Developer-Centric Security:** Strict sanitization pipelines to mitigate Markdown injection and cross-site scripting (XSS), keeping code blocks raw but entirely harmless.
- **Isolated Code Sandboxing:** Spawns restricted child processes or isolated native `vm` contexts to safely execute user-submitted code snippets directly inside the backend.
