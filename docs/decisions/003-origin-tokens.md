# ADR 003: Exact origin plus capability tokens

Status: accepted. Documented 2026-11-17.

## Context

A loopback bind does not stop an unrelated browser page from trying requests to local services. Host aliases and other local ports must not silently become trusted origins.

## Decision

Match the bound scheme, host and port; require unpredictable tokens for privileged operations. Forge uses a per-launch token for WebSocket and HTTP mutations, obtained through a same-origin session endpoint.

Implementation and tests: [network-guard.ts](../../src/server/network-guard.ts) and [network-guard.test.ts](../../src/server/network-guard.test.ts); real browser rejection tests are linked in [failure modes](../FAILURE-MODES.md).

## Alternatives

Loopback-only accepts too much browser-origin traffic. A full login system adds account/session complexity to a local single-user tool. Wildcard CORS would expand the trust boundary.

## Consequences

Browser-origin attacks face two checks. Local same-user processes remain trusted and can access capabilities. This is unsuitable for public tunnels or a multi-tenant service without a different authentication and isolation design.
