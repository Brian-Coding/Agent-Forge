# Agent Forge

Agent Forge is a local, browser-based harness for running multiple Claude Code and Codex agents against real project directories. It provides workspace-scoped agent panes, durable chat history, live turn progress, usage/limit reporting, image attachments, terminal/process supervision, browser QA, UI Atlas generation, and shared project instructions.

The application is intentionally local and single-user. Bun owns the main server and provider adapters; a small Node subprocess owns Playwright because its browser lifecycle is more reliable outside Bun on Windows.

## Requirements

- [Bun](https://bun.sh/) 1.3 or newer
- Node.js for the Playwright browser worker
- At least one installed and authenticated provider CLI: `codex` or `claude`
- Chromium only when using Browser QA/UI Atlas or the live browser integration test

## Start

```bash
bun install
bun run dev
```

Open the local URL printed by the server, normally `http://localhost:3333`. If that port is occupied, Agent Forge tries the next seven ports. `PORT` can select the starting port. The server binds to `127.0.0.1` by default; do not set `HOST` to a non-loopback interface without separately reviewing the security boundary.

For browser automation:

```bash
bunx playwright install chromium
```

## Architecture

```text
Browser UI (src/client/index.html)
        │ HTTP + WebSocket
        ▼
Bun server (src/server)
  ├─ workspaces, agents, chat, persistence, usage, limits
  ├─ Claude/Codex adapter registry and normalized events
  ├─ terminal and child-process supervision
  ├─ QA and UI Atlas coordinators
  └─ guarded local filesystem operations
        │ local HTTP, spawned on demand
        ▼
Node + Playwright worker (scripts/browser-worker.mjs)
```

Provider-specific parsing and launch behavior belongs in `src/server/agents/adapters/`. Shared lifecycle, persistence, QA, Atlas, and prompt behavior belongs in services. The client/server wire contract lives in `src/shared/protocol.ts`.

## State and artifacts

- `data.json`: repo-relative application state for the current development installation
- `pids.json` and `agent-forge.lock`: current checkout's process metadata
- `.plans/`: source-controlled plan files; these files are canonical and are discovered directly
- QA screenshots: stable platform data directory, normally `%LOCALAPPDATA%\AgentForge\artifacts` on Windows or `$XDG_DATA_HOME/agent-forge/artifacts` on Unix-like systems
- Published UI Atlas: `docs/ui-atlas/` inside the target application repository
- Cross-machine usage runtime shard: `~/.agent-forge/usage-sync/usage/`

The current repo-relative core state is a known limitation. The canonical roadmap sequences recovery proof and explicit stable/development instance isolation before any live-state migration or release updater.

## Safety boundary

Agent Forge-owned destructive filesystem operations use protected-root checks, canonical path validation, link detection, bounded tree scans, quarantine-first deletion, and audit records. The HTTP server is loopback-only by default and applies Host/Origin checks plus strict wire/body validation.

These protections do not intercept every raw shell command emitted by a provider. Claude and Codex currently run with broad provider permissions for compatibility. Use recoverable worktrees and provider sandbox modes where appropriate, and do not expose the server to a network as if it were an authenticated remote service.

## Verification

```bash
# TypeScript plus deterministic randomized-order suite
bun run check

# Source coverage plus the weighted coverage ratchet
bun run test:coverage
```

The live Chromium integration is opt-in:

```powershell
$env:RUN_BROWSER_INTEGRATION='1'
$env:BROWSER_HEADLESS='1'
bun test src/server/services/browser.service.integration.test.ts
```

On macOS/Linux:

```bash
RUN_BROWSER_INTEGRATION=1 BROWSER_HEADLESS=1 \
  bun test src/server/services/browser.service.integration.test.ts
```

CI runs the randomized suite on Windows, macOS, and Linux, enforces source coverage on Linux, and runs the live Chromium smoke separately.

## Project direction and documentation

- [Plan lifecycle index](.plans/README.md): authoritative status of every plan.
- [Documentation index](docs/README.md): operational and technical references.
- [Historical reviews](improvements/README.md): dated audits retained as evidence, not active backlog.

The immediate direction is conservative: close the current acceptance gaps, prove recovery without changing the daily driver, then prove stable and development instances can coexist. Packaging, automatic updates, Tauri, and any native rewrite come later—if they are still justified.
