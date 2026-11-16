# Architecture

Agent Forge is one Bun process serving a single-page browser UI over HTTP and a WebSocket.

```text
Browser UI  (src/client/index.html, React from bun.lock, bundled at startup)
     │  HTTP + WebSocket on 127.0.0.1
     ▼
Bun server  (src/server)
  ├─ ws.ts / client-message.ts   validated WebSocket commands
  ├─ routes/                     small HTTP endpoints (ports, git, models, usage, images, health)
  ├─ services/                   workspaces, agents, chat turns, persistence, usage, limits,
  │                              terminals, project watchers, safe filesystem, process ownership
  ├─ agents/                     provider registry + Claude / Codex adapters
  └─ auth/                       provider sign-in classification and recovery
     │  spawns
     ▼
Provider CLIs (claude, codex) and terminal commands, one process tree per turn
```

## Key ideas

- **The server owns the truth.** Agent status, the command queue, live turn state, and history live on the server. The browser renders snapshots and never re-submits work on its own after a reconnect; it only replays commands it never managed to send.
- **Adapters isolate providers.** Everything provider-specific (CLI flags, stream parsing, session resume, model discovery, error shapes) lives in `src/server/agents/adapters/`. They emit normalized events from `src/server/agents/events.ts`; the rest of the server is provider-agnostic.
- **One prompt builder.** `services/prompt-builder.service.ts` assembles guardrails, persona, shared instructions, plans, and reference folders for every provider. The Settings screen reads the same constants, so what you see is what agents get.
- **Wire contract in one place.** `src/shared/protocol.ts` defines every WebSocket message and persisted type. `client-message.ts` validates incoming commands against it with exact-key checks.
- **Durable, bounded state.** `persistence.service.ts` writes `data.json` atomically, normalizes and bounds everything it loads, coalesces writes, and preserves damaged files rather than overwriting them.
- **Proven process ownership.** Every child process is recorded with identity evidence; startup only cleans up orphans it can prove it owns. A lock file keeps two servers from sharing one state folder.
- **Shared watchers.** Agents working in the same project share one file watcher per canonical root for file-change and `.plans/` updates.

## Tests

`bun run check` runs the TypeScript compiler and the full test suite in randomized order with a fixed seed. Tests live next to the code they cover (`*.test.ts`). Notable suites:

- `server.e2e.test.ts` boots a real server against a temporary state folder.
- `agents/adapters/adapter-process.integration.test.ts` runs the adapters against scripted fake provider processes.
- `src/client/*.test.ts` exercise the browser code (including the WebSocket queue hook) against controlled transports.

`bun run test:coverage` adds a weighted coverage ratchet (`scripts/check-coverage.ts`).

## Persistence migration

Schema 1 is current. Historical schema 2 is imported through the same allowlist and saved as schema 1 after preserving a recovery copy. Removed feature fields are discarded at normalization; no extracted feature runtime or report normalization remains.
