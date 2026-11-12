# Guide for coding agents

You are working on Agent Forge, a local Bun + TypeScript harness that runs Claude Code and Codex agents. Read [docs/architecture.md](docs/architecture.md) first.

## Commands

- `bun install`: install dependencies
- `bun run dev`: start the server (prints its URL; default port 3333)
- `bun run check`: typecheck + all tests. Run it before you hand off any change.
- `bun run test:coverage`: coverage with the weighted ratchet; use it for persistence, process, provider, or safety changes.

## Conventions

- Use Bun everywhere (`bun test`, `bun run`, `bunx`, `Bun.serve`, `Bun.spawn`). Do not add Express, Vite, Jest, or dotenv.
- The browser UI is a single file, `src/client/index.html`, with React loaded from a CDN and no build step. Keep it that way unless a change is agreed first. `src/client/workspace-selection.test.ts` checks that its inline script still parses.
- Every WebSocket command is declared in `src/shared/protocol.ts` and validated with exact keys in `src/server/client-message.ts`. Change both together and add a case to `client-message.test.ts`.
- Provider-specific code belongs in `src/server/agents/adapters/`. Everything else consumes normalized events.
- Filesystem deletion goes through `src/server/services/safe-filesystem.mjs`. Process termination goes through the ownership checks in `process-ownership.ts`. Do not bypass them.
- Tests sit next to the code they cover. Prefer injected fakes over touching the real home folder, real provider CLIs, or the network.
- Fixtures and docs use fictional names and paths (`C:\Users\dev\code\acme-store`, `/Users/dev/code`). Never commit secrets, real chat logs, or `data.json*` files.

## Do not

- Commit, push, or open pull requests unless the person you are working for asks.
- Weaken the loopback/Origin checks in `src/server/index.ts` or the built-in guardrails in `prompt-builder.service.ts` without an explicit request.
