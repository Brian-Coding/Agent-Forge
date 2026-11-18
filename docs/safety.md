# Safety model

Agent Forge is a single-user tool that runs on your own machine. This page explains what it protects and where its protection ends.

## What agents can do

Agent Forge starts Claude Code with `--dangerously-skip-permissions` and Codex with `--dangerously-bypass-approvals-and-sandbox`. That is what lets agents work unattended in a pane, and it means **an agent can read, write, and run anything your user account can** in and beyond the folders you give it. Agent Forge does not intercept the shell commands an agent runs.

Practical advice:

- Point agents at projects under version control, and commit or branch before big requests.
- Use Git worktrees to give parallel agents separate copies of a repository.
- Do not run Agent Forge as an administrator/root user.
- Keep secrets out of shared instructions and chat; the guardrails tell agents not to print secrets, but a prompt is not a security boundary.

## What the guardrails do

Every turn starts with a fixed set of instructions you can read in **Settings → Inherent instructions**. They tell agents not to commit, push, merge, delete branches, or run destructive commands unless you explicitly ask; to preserve work they did not create; to verify paths before recursive deletes; and to treat external services as read-only unless you authorize a change. These rules shape behavior. They are not enforcement.

## What the server protects

- **Loopback only.** The server binds to `127.0.0.1` by default and rejects non-loopback binds. Requests must match the bound scheme, hostname, and port. Other loopback names and ports are different origins. WebSocket connections and HTTP mutations also need an unguessable per-launch token. The UI obtains it from a same-origin, non-cacheable `/api/session` response. Non-browser automation can obtain that token locally and explicitly send `x-forge-token` or the `forge-auth.<token>` WebSocket subprotocol. Missing browser origins do not substitute for a token.
- **Bounded input.** WebSocket commands have exact schemas and reject unknown fields. HTTP bodies have byte limits and route-specific validation; not every HTTP route rejects extra JSON fields.
- **Guarded cleanup.** Codex temporary-output cleanup and Xcode DerivedData cleanup resolve real paths, refuse symlinks and junctions, reject broad or protected roots, bound tree walks, and write audit records. DerivedData moves to recoverable quarantine. Each Codex turn writes into a separate child of a private temporary container created once per Forge process. Turn finalization permanently removes that child and its `last-message.txt`, including when the checkout is under the system temp directory; the empty container remains in the system temp directory. Cleanup failures produce warnings, and an abrupt process exit can leave output behind. Lock files and failed atomic-write temporary files use separate, narrowly scoped cleanup routines.
- **Owned process cleanup.** Provider and terminal launches own POSIX process groups. Cleanup signals the group and checks for live members, including after the root exits; a failed parent-only fallback cannot claim tree success. Windows uses bounded `taskkill /T`. Processes that deliberately create a new session can escape this mechanism; it is not an OS sandbox.
- **Explicit external stops.** The port panel can stop a listener you select even if Forge did not start it. A short-lived selection token binds the port to the observed PID, executable name, and start time; the server rechecks the listener and birth identity before signaling. This stops that process only, and is separate from owned tree cleanup. System/self/parent PIDs are refused. Portable PID checks cannot eliminate the final OS-level PID-reuse race.
- **Durable state.** State is written atomically with bounded sizes; corrupt or oversized files are preserved for recovery instead of being overwritten.

## What it does not do

- There is **no user login**. Other local processes running as you are trusted and can acquire the launch token. Do not expose the service through a tunnel or reverse proxy.
- It launches provider CLIs with their sandbox and approval prompts disabled. Use a container or a separate OS user to isolate Forge and its children; there is no setting in Forge to enable the CLIs' sandbox modes.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue. See [SECURITY.md](../SECURITY.md).

## Network dependencies

React 19, Marked, DOMPurify, and Highlight.js are bundled from the lockfile and served locally. DOMPurify 3.4.17 replaces the old CDN pin; its package integrity is recorded in `bun.lock`. The upgrade is preventive maintenance, not a claim of a demonstrated exploit in this app. See the [upstream release history](https://github.com/cure53/DOMPurify/releases/tag/3.4.17).

Provider CLIs contact their providers; the server also calls provider model and usage endpoints. Source, prompts, and images may leave the machine through providers. Bundle license texts are served at `/third-party-notices.txt`.
