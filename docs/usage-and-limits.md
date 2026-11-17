# Usage and limits

## Token usage

The **Token Usage** sidebar (🪙) shows tokens per turn recorded by Agent Forge, broken down by provider, agent, model, and day, across time windows (today, 7 days, 30 days, this month, all time). Only tokens are shown, because only some providers report cost. You can export the current view as CSV or JSON.

Usage history lives in Agent Forge's state file and in a per-machine shard under `~/.agent-forge/usage-sync/usage/`. If you use Agent Forge on several machines, set `AGENT_FORGE_USAGE_SYNC_DIR` on each one to the same folder in something you already sync (Syncthing, a cloud drive, ...). Each machine writes only its own shard, and the **All machines** scope merges them.

## Limits

The **Limits** sidebar (⏳) and the bottom bar show your providers' rate-limit windows and when they reset.

- **Claude:** read from the same usage endpoint Claude Code's `/status` uses, with the token Claude Code already stores locally. This costs no tokens. As a fallback, `scripts/claude-limits-statusline.ts` can be installed as a Claude Code status-line command; it writes the limits Claude Code reports to a local file that Agent Forge reads.
- **Codex:** read from the Codex CLI's app server, falling back to the rate-limit events Codex writes to its local session logs.

Limits refresh every minute and when you click refresh. Each provider is cached separately, so one broken source never blanks the other.

## Last-run accounting

Each agent card shows provider-reported input tokens, output tokens and cost for its last finished process run. A reported zero is displayed as zero; missing usage says **unknown**. The record persists through restart. Interrupted runs can contain only partial accounting. Long-lived Codex processes can include several completed turns in one run total. Claude message IDs prevent repeated snapshots from being counted twice; final aggregates can correct earlier totals upward or downward. Codex output uses the provider’s output aggregate directly.

The historical Tokens dashboard also contains estimates and aggregates; it is not an invoice. No dollar cap or billing reconciliation is enforced. Set provider-side budgets before increasing concurrency. Scripted demos emit no fabricated usage.
