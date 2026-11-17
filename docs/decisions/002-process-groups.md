# ADR 002: Own the process group, not just the CLI PID

Status: accepted. Documented 2026-11-17.

## Context

A provider can spawn a shell and dev server. Killing the root alone leaves descendants running; inherited stdout can keep a completed turn waiting forever. Persisted PIDs may also be reused.

## Decision

Launch POSIX children in owned groups. On cancellation, timeout and root exit, terminate and verify the group with bounded waits. Retain final output while unwinding. Windows uses bounded tree termination. Startup cleanup separately proves persisted process identity before signaling.

Implementation: [utils.ts](../../src/server/utils.ts), provider adapters and real-process regression suites linked in [failure modes](../FAILURE-MODES.md).

## Alternatives

Parent-only kill is simpler but leaks children. A container/cgroup or OS job object offers stronger containment with more platform/setup cost. An unbounded wait risks hanging shutdown.

## Consequences

Cooperative descendants are cleaned even if the root exits first. A process that deliberately detaches into another session can escape. Linux stand-ins test lifecycle mechanics; this is not native-platform or live-provider certification.
