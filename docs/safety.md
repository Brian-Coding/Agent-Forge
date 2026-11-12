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

- **Local only by default.** The server binds to `127.0.0.1`. Requests must carry a loopback `Host` header, and browser requests must come from a loopback origin, which blocks DNS-rebinding and cross-site requests from other tabs.
- **Strict input.** Every WebSocket command and HTTP body is size-limited and validated against an exact schema; unknown fields are rejected.
- **Guarded file operations.** When Agent Forge itself removes files (temporary folders, uploaded images), it resolves real paths, refuses symlinks and junctions, refuses broad or protected roots such as your home folder, bounds tree walks, prefers quarantine over permanent deletion, and writes an audit record.
- **Process ownership.** Agent Forge only stops processes it can prove it started (PID plus start time and command line), so a reused PID never gets someone else's process killed. The port panel refuses PID 1, process groups, and the server itself.
- **Durable state.** State is written atomically with bounded sizes; corrupt or oversized files are preserved for recovery instead of being overwritten.

## What it does not do

- There is **no login**. Anyone who can reach the port can drive your agents. Do not set `HOST` to a non-loopback address, put it behind a tunnel, or expose it on a network.
- It does not sandbox provider CLIs. Use the CLIs' own sandbox modes, containers, or a separate OS user if you need isolation.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue. See [SECURITY.md](../SECURITY.md).
