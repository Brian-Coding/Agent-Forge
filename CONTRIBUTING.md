# Contributing to Agent Forge

Thanks for helping. Agent Forge is a small, opinionated tool for running coding agents locally; changes that make it more reliable, clearer, or safer are the most welcome.

## Set up

```bash
bun install --frozen-lockfile
bun run dev      # start the server
bun run check    # typecheck + full test suite (randomized order, fixed seed)
```

You do not need a provider account to run the tests; adapter tests use scripted fake providers.

## Before you open a pull request

- `bun run check` passes.
- New behavior has a test next to the code (`something.test.ts`). For persistence, process, provider, or safety changes, also run `bun run test:coverage`.
- UI changes: describe what you checked in the browser, and include a screenshot when it helps.
- Keep the wire contract in `src/shared/protocol.ts` and the validator in `src/server/client-message.ts` in sync.
- Provider-specific logic stays in `src/server/agents/adapters/`.
- No secrets, personal paths, or real user data in code, fixtures, or docs. Use clearly fictional examples.

## Scope

Agent Forge deliberately stays a local, single-user harness. Proposals that add remote access, accounts, or cloud services should start as an issue so we can talk about the security model first (see [docs/safety.md](docs/safety.md)).

## Reporting bugs

Open an issue with what you did, what you expected, what happened, your OS, Bun version, and provider CLI versions (the runtime pill in the bottom-left corner shows the ones Agent Forge is running). Please remove anything private from logs before pasting them.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).

## Reproducible validation

The Linux CI gate runs the following after the frozen install above. Browser checks need Node.js 20+ and Playwright's Chromium (`bun run browsers:install`; Linux CI uses `bunx playwright install --with-deps chromium`).

```bash
bun run check
bun run test:coverage
bun run test:browser
bun run demo:check
```

Measured on Linux with Bun 1.4.4 on November 17, 2026: **415 tests across 74 files**, with **78.75% weighted line coverage** and **83.35% function coverage** across 71 LCOV source records. Coverage does not include the inline browser script or child-process execution; the browser and demo gates check those paths separately.

These checks use fixtures and scripted providers; they do not evaluate model quality or certify live CLI compatibility. Read [failure modes](docs/FAILURE-MODES.md) and [decisions](docs/decisions/README.md) when changing a trust boundary. `bun run media` regenerates the fictional recording; run it only when updating demo media and inspect the frames. See [media instructions](docs/media.md).
