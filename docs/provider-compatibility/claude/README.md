# Claude CLI compatibility fixtures

Auth-classifier fixture version and configured compatibility floor: **Claude Code 2.1.241**. These fixtures do not certify live-provider compatibility.

These files capture the success and failure output shapes Agent Forge has observed from the Claude CLI. `src/server/auth/classify-claude-auth.test.ts` replays them to lock the sign-in classifier that decides whether a Claude turn may start and which recovery action the UI offers.

| Fixture | Meaning |
|---|---|
| `auth-status-logged-in.json` | `claude auth status` JSON with `loggedIn: true`. Configured, not inference-verified. |
| `auth-status-logged-out.json` | CLI reports not logged in. |
| `auth-status-malformed.json` | Non-JSON status output. Inconclusive, not a false logout. |
| `auth-status-timeout.json` | Status command exceeded the bounded timeout. |
| `cli-missing.json` | Claude executable is not available. |
| `turn-access-token-expired.json` | Existing expired-access-token assistant text. |
| `turn-oauth-revoked.json` | Revoked OAuth login. |
| `turn-invalid-api-key.json` | Higher-precedence API key name conflict. The fixture names the method, not a secret. |
| `turn-rate-limited.json` | Non-auth provider failure. Stays degraded. |

Do not put credential values, account identifiers, or raw `.credentials.json` contents in this directory.
