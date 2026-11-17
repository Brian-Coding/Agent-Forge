# Changelog

## Unreleased — 2026-11-16 (private preview)

- Preserve the workspace App URL across restarts while continuing to discard removed feature state.
- Require the exact launch origin and an ephemeral capability for WebSocket/HTTP mutations.
- Launch owned POSIX process groups and verify descendant cleanup; revalidate selected external listeners before stopping them.
- Treat project-directory changes as a provider-session boundary and refuse them during active turns.
- Remove extracted-feature persistence normalization and repair the coverage gate.
- Bundle React 19, Marked, DOMPurify 3.4.17, and Highlight.js from the lockfile; add browser sanitizer and file-link regression checks.
- Support POSIX and file-URL project links; ignore dotenv variants; clarify private publication instructions.
- Add real demo screenshots, architecture documentation, third-party notices, and [measured performance](docs/performance.md). The local bundle improves sampled UI loading while adding startup/build work.

Follow-up review: start descendant cleanup on provider exit even when inherited pipes remain open; retain the final streamed answer; remove the unused extracted Node-child helper; decode file-URL pathnames after parsing, including spaces and Unicode; extend real Markdown pipeline checks.

### Portfolio evidence pass

- Show last-run reported tokens/cost and distinguish unknown from reported zero.
- Add an account-free scripted workbench demo with real terminal checks and reproducible media.
- Fall back to Linux `ss` when `lsof` is unavailable for port inventory.
- Document failure modes, architectural decisions and a practical team rollout.
