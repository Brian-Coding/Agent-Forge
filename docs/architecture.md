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

## Concurrency and failure boundaries

One queue per agent allows parallel tasks while preserving order within a conversation. A command request ID prevents repeat execution after reconnect within the running server; it is not a durable distributed exactly-once protocol. Cancellation invalidates the old turn epoch, so late provider callbacks cannot modify a new turn. The [chat integration suite](../src/server/services/chat.service.integration.test.ts) tests both races and concurrent agents.

Workspace grouping deliberately does not lock source files. Use Git worktrees for writers. Canonical-root watcher sharing reduces duplicate observation, but cannot resolve conflicting edits. Persisted state uses an exclusive instance lock plus atomic writes; runtime queues do not survive restart. Provider/model changes invalidate the resume identity.

## Trust and accounting

The [network guard](../src/server/network-guard.ts) combines exact origin and launch capability. [Safe filesystem operations](../src/server/services/safe-filesystem.mjs) constrain harness cleanup, while provider shell access remains broad. [Owned process checks](../src/server/services/process-ownership.ts) prevent startup cleanup from treating an unrelated reused PID as its child. Neither prompt instructions nor POSIX groups create an OS sandbox.

Last-run usage is a separate record from historical estimates: missing counters remain unknown, a reported zero remains zero, and Claude result aggregates reconcile streamed token deltas. Codex output uses the reported output aggregate without adding other fields. These values reflect CLI reporting, not independently reconciled billing. Long-lived provider processes may contain multiple turns; the card total covers that process run. A killed process may report only partial usage.

## Tradeoffs and evidence

The inline UI remains large and untyped; it has focused script/queue/browser tests, but splitting it is future structural work. Large provider adapters carry protocol and lifecycle complexity. The chosen pass adds narrow typed accounting instead of restructuring those paths without behavioral need. [Performance](performance.md) records the measured local-bundle startup cost and browser improvement, with no new speed claim from this pass.

Read the [decision records](decisions/README.md), [failure-to-test map](FAILURE-MODES.md), and [team rollout](ADOPTION.md) before expanding automation.
