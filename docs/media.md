# Reproduce the demo recording

These are recordings of the running application on Linux with fictional Acme Notes data. No generated mockups, live provider output, personal projects or accounts are used.

```bash
bun install --frozen-lockfile
bun run browsers:install
bun run media
```

Node.js 20+ and ffmpeg on PATH are required for recording. Chromium uses the Playwright install above. The script creates disposable workbench state, registers scripted adapters in a demo-only process, sends messages through the actual browser UI, and runs real Node tests plus a real preview server in terminals. It shows the actual listening preview port; recording filters unrelated machine ports. Normal `bun run dev` does not load these adapters. `bun run demo` leaves the interactive demo open until Ctrl+C; `bun run demo:check` verifies the same flow without video. Linux port inventory needs `lsof` or `ss`.

Outputs: [GIF](images/forge-demo.gif), [MP4](images/forge-demo.mp4), [PNG](images/forge-demo.png). Source: [launcher](../scripts/demo.ts), [stand-ins](../scripts/demo/server.ts), [recorder](../scripts/demo/record.mjs).

Recordings depend on browser timing, so frame timings and generated run IDs may vary. The committed GIF stays below 5 MB. Inspect every frame before sharing recordings made against any other data. The scripted demonstrations establish workflow plumbing, not live Claude/Codex performance or compatibility.
