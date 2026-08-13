# Agent Forge

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run dev
```

## Reliability checks

```bash
# Typecheck plus a deterministic randomized-order suite
bun run check

# Source-only text/LCOV coverage plus the weighted coverage ratchet
bun run test:coverage
```

The Playwright service smoke is gated because it requires a local Chromium
installation. Install it with `bunx playwright install chromium`, then run:

```powershell
$env:RUN_BROWSER_INTEGRATION='1'; $env:BROWSER_HEADLESS='1'; bun test src/server/services/browser.service.integration.test.ts
```

On macOS/Linux, use `RUN_BROWSER_INTEGRATION=1 BROWSER_HEADLESS=1 bun test
src/server/services/browser.service.integration.test.ts`.

CI runs the randomized suite on Windows, macOS, and Linux, enforces source
coverage on Linux, and executes the live Chromium smoke separately.

This project was created using `bun init` in bun v1.3.9. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Operational and design notes

- [Google Docs tracker reconciliation](docs/google-docs-tracker-reconciliation.md) — evidence-backed, scheduled project-tracker reconciliation on a configured host.
- [Cross-machine token-usage sync](docs/usage-sync.md) — Git-backed, per-machine usage snapshots and optional scheduling.
- [Long-running agent reliability](docs/long-running-agent-reliability.md) — confirmed failure analysis, current workarounds, and the durable recovery design for multi-hour runs.
- [Model mismatch and CLI stability](docs/model-mismatch-and-cli-stability.md) — cross-machine CLI version skew and defensive provider-event parsing.
