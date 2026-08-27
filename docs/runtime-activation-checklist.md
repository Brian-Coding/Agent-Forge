# Runtime activation checklist

Use this after a controlled Agent Forge restart. It does not start, stop, or replace a server.

1. Record the old `/api/health` `runtime.serverSessionId` and `runtime.runningFingerprint`.
2. Stop the intended process with the normal shutdown path. Do not kill unrelated Bun processes.
3. Start the intended checkout on an explicit port and state directory.
4. Poll `GET /api/health` until it returns 200.
5. Confirm a new `serverSessionId` and that `runningFingerprint` matches the source you intended to launch.
6. Confirm `drift` is `current` (or `unknown` only if a critical file is unreadable). `restart-required` means the old process is still serving.
7. Load the UI. The bottom-bar pill should read **Runtime current**. There should be no Restart required banner.
8. Run one read-only UI/API smoke (`/api/health`, `/api/models`, WebSocket open). Do not treat that as provider authentication.
9. Run a live Claude or Codex prompt only in an approved safe environment, and only after the fingerprint check passes.

`auth` on `/api/health` is the same coordinator snapshot used to gate Claude turns. Codex stays `not-probed` and is not blocked by Claude state. Inconclusive Claude results still allow one bounded bootstrap; only definitive failures block.

Auth recovery cards (`Check again`, `Retry preserved prompt`) are server-session state. A browser reload on the same server keeps them; a server restart does not. The accepted user prompt remains in chat history either way.

The health payload must stay redacted: no API keys, OAuth tokens, credential-file contents, or prompt text.
