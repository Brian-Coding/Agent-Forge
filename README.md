# Agent Forge

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.9. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Operational and design notes

- [Google Docs tracker reconciliation](docs/google-docs-tracker-reconciliation.md) — evidence-backed, scheduled project-tracker reconciliation on a configured host.
- [Cross-machine token-usage sync](docs/usage-sync.md) — Git-backed, per-machine usage snapshots and optional scheduling.
- [Long-running agent reliability](docs/long-running-agent-reliability.md) — confirmed failure analysis, current workarounds, and the durable recovery design for multi-hour runs.
- [Model mismatch and CLI stability](docs/model-mismatch-and-cli-stability.md) — cross-machine CLI version skew and defensive provider-event parsing.
