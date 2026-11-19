# Recordings

## Live showcase

[MP4](images/forge-showcase.mp4) · [GIF](images/forge-showcase.gif) · stills: [six agents running](images/forge-showcase.png), [terminal and machine ports](images/forge-showcase-terminal.png), [finished results](images/forge-showcase-results.png)

This is one real session of Agent Forge on Linux. It is not scripted.

- **Projects:** six small, original sample projects created for the recording (a React todo app, a Bun API, a Node CLI, a canvas game, a docs site and a Python script). Each one is its own workspace.
- **Agents:** 18 in total. 15 ran Claude Code (Sonnet 5.5) and 3 ran Codex (GPT-6.1 Terra, low reasoning).
- **Turns:** every prompt was typed through the browser UI and every reply is unedited provider output. Agents in each workspace share the project directory, so some replies mention edits made by their neighbours.
- **What it covers:** small tasks, a follow-up queued while a pane was busy, a second round of follow-ups, `/diff-check` review in the Reviewer pane, `npm test` and `npm run serve` in terminals, and the machine ports panel.
- **Scale:** at least 14 turns ran at the same time, and the session ran 34 turns in 2.4 minutes. Claude usage reported by the app came to about $1.70.

Frames were captured with the Chromium screencast and played back at **2× speed**. Any stretch where the screen did not change for more than 3 seconds was shortened. The ports panel was filtered to the session's own preview port (5190) to hide unrelated processes on the recording machine. The 7-day Codex usage pill is real account data.

## Reproduce the offline demo recording

These are recordings of the running application on Linux with fictional Acme Notes data. No generated mockups, live provider output, personal projects or accounts are used.

```bash
bun install --frozen-lockfile
bun run browsers:install
bun run media
```

Node.js 20+ and ffmpeg on PATH are required for recording. Chromium uses the Playwright install above. The script creates disposable workbench state, registers scripted adapters in a demo-only process, sends messages through the actual browser UI, and runs real Node tests plus a real preview server in terminals. It shows the actual listening preview port; recording filters unrelated machine ports. Normal `bun run dev` does not load these adapters. `bun run demo` leaves the interactive demo open until Ctrl+C; `bun run demo:check` verifies the same flow without video. Linux port inventory needs `lsof` or `ss`.

Outputs: [GIF](images/forge-demo.gif), [MP4](images/forge-demo.mp4), [PNG](images/forge-demo.png). Source: [launcher](../scripts/demo.ts), [stand-ins](../scripts/demo/server.ts), [recorder](../scripts/demo/record.mjs).

The demo process installs [offline services](../scripts/demo/offline-services.ts) for model discovery, provider health/auth and limits, including manual refreshes. It uses the same endpoints as the interactive UI; the recorder does not substitute model responses. An [isolated process regression](../scripts/demo/offline-services.test.ts) rejects unexpected provider subprocess or network access. User-entered terminal commands still run with the local user's permissions.

Recordings depend on browser timing, so frame timings and generated run IDs may vary. The committed GIF stays below 5 MB. Inspect every frame before sharing recordings made against any other data. The scripted demonstrations establish workflow plumbing, not live Claude/Codex performance or compatibility.
