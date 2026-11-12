# Configuration

Agent Forge works with no configuration. Everything below is optional.

## Server

| Setting | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3333` | First port to try. If it is busy, the next seven ports are tried. |
| `HOST` | `127.0.0.1` | Interface to bind. Leave this on loopback; see [Safety model](safety.md). |
| `AGENT_TURN_INACTIVITY_MS` | unset | Stop a turn after this many milliseconds with no provider output. Unset means long-running turns are never cut off automatically. |

## Providers

| Setting | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | When set, Claude models discovered through the API are merged into the model list. Not needed for normal Claude Code sign-in. |
| `AGENT_FORGE_SKIP_CLAUDE_AUTH_CHECK=1` | Skip the pre-turn Claude sign-in probe (useful in unusual auth setups). |
| `CODEX_HOME` | Respected the same way the Codex CLI respects it. |

Agent Forge prefers provider CLIs installed in your user-local bin folders over global ones, and shows which CLI binary and version it is actually running in the runtime health pill at the bottom left.

## Usage and limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `AGENT_FORGE_MACHINE_ID` | hostname | Name for this machine in multi-machine usage reports. |
| `AGENT_FORGE_USAGE_SYNC_DIR` | `~/.agent-forge/usage-sync/usage` | Folder for per-machine usage shards. Point several machines at one synced folder to merge their usage. |
| `AI_HARNESS_CLAUDE_LIMITS_JSON` | `~/.claude/claude-code-limits.json` | File written by the optional Claude status-line bridge. |
| `AI_HARNESS_CLAUDE_CREDENTIALS_JSON` | Claude Code's credentials file | Where to read the Claude token used for the limits endpoint. |
| `AI_HARNESS_CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex session logs used as a fallback limits source. |

## Where state lives

| What | Where |
| --- | --- |
| Workspaces, agents, chat history, settings, usage | `data.json` in the folder you start the server from (the repository root with `bun run dev`) |
| Process bookkeeping | `pids.json`, `owned-processes.json`, `agent-forge.lock` next to `data.json` |
| Uploaded chat images and other artifacts | `%LOCALAPPDATA%\AgentForge\artifacts` on Windows, `$XDG_DATA_HOME/agent-forge/artifacts` or `~/.local/share/agent-forge/artifacts` elsewhere. Override with `AGENT_FORGE_ARTIFACT_ROOT`. |

All of these are ignored by Git. `data.json` contains your conversations, so treat it as private. Agent Forge keeps recovery copies (`data.json.recovery-*`, `data.json.corrupt-*`, `data.json.oversized-*`) next to it if it ever finds a damaged or oversized state file; those are private too.

Only one Agent Forge server can own a given state folder at a time. Starting a second one from the same folder asks the first to shut down cleanly before taking over.
