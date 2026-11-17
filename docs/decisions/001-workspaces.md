# ADR 001: Workspace grid with independent agent sessions

Status: accepted. Documented 2026-11-17.

## Context

An engineer needs to supervise implementation, tests and review in parallel without losing which directory, provider session or queued turn belongs to each task.

## Decision

A workspace groups panes and app context. Each agent owns a provider/model session and a serial turn queue; different agents run concurrently. The server owns state and the browser renders snapshots. Canonical project roots share watchers. Changing project/provider/model starts a fresh provider session while retaining visible chat history.

Implementation: [workspace service](../../src/server/services/workspace.service.ts), [chat bridge](../../src/server/services/chat.service.ts), [agent service](../../src/server/services/agent.service.ts). [Chat integration tests](../../src/server/services/chat.service.integration.test.ts) prove independent concurrent agents and bounded cancellation; [project watcher tests](../../src/server/services/project-watcher.service.test.ts) cover shared watchers.

## Alternatives

A single global queue prevents useful concurrency. Fully independent application instances duplicate watchers and scatter review context. A branch/merge scheduler would enforce more coordination but requires product decisions about conflict ownership.

## Consequences

The engineer chooses parallelism and sees failures in context. A workspace is a UI grouping, not a filesystem sandbox: two agents can edit the same files. Use separate Git worktrees for independent writers; humans own integration and release approval.
