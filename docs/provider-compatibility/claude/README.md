# Claude CLI compatibility fixtures

Qualified CLI floor for these fixtures: **Claude Code 2.1.241**.

These files capture the success and failure shapes Agent Forge already observes. They lock the authentication classifier. The supported compatibility floor is **2.1.241**. Slice B runs that classifier in shadow mode: health and logs may show the typed state, but turn gating and retry stay on the previous adapter path.

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
