# Agent Forge Documentation Index

This directory contains current operational documentation and detailed design references. Implementation authorization and sequencing live in [`.plans/README.md`](../.plans/README.md); dated snapshots live in [`improvements/`](../improvements/README.md).

## Current

- [Google Docs tracker reconciliation](./google-docs-tracker-reconciliation.md): active scheduled reconciliation design and safety boundary.
- [Cross-machine token-usage sync](./usage-sync.md): active per-machine usage snapshot workflow.
- [Harness evals](./harness-evals.md): durable criteria for evaluating whether harness changes are actually better.

## Current reference with open work

- [Long-running agent reliability](./long-running-agent-reliability.md): incident analysis and operational reference; immediate liveness fixes exist, durable orchestration does not.
- [Model mismatch and CLI stability](./model-mismatch-and-cli-stability.md): multi-machine CLI drift analysis; some parser hardening is implemented, version policy and consistent model normalization remain.

## Paused reference

- [Unreal MCP with Codex and Agent Forge](./unreal-mcp-agent-forge.md): setup/design reference for an explicitly paused integration.
- [Unreal MCP implementation prompt](./unreal-mcp-agent-forge-implementation-prompt.md): copy/paste execution brief; do not use until the user resumes the plan.

## Superseded backlog

- [QA Agent future work](./qa-agent-future-work.md): older unprioritized backlog. Still-valid ideas were reconsidered in the canonical development roadmap; this file no longer authorizes work.

## Placement rules

- Put plans, approval state, and development sequencing in `.plans/`.
- Put current runbooks, incident analyses, architecture notes, and technical references in `docs/`.
- Put point-in-time review snapshots in `improvements/` and date them.
- Update this index when adding a durable document.
- Prefer updating an existing document over creating a second document for the same decision.
