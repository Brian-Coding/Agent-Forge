# Performance measurements

Measured on November 16, 2026, on this Linux x86_64 development machine with Bun 1.4.4, Node 24.22.1, and Chromium 151. Local fixtures only; no live model calls. These are development observations, not capacity or cross-platform claims.

The baseline was d407165; the after measurements use this readiness implementation. Startup, build, and HTTP values are medians of seven sequential runs (ten HTTP requests per run). Startup ends at the first successful readiness response, polled every 5 ms. Builds are in-memory Bun browser builds with minification. Filesystem caches were warm; machine load was not controlled.

| Measurement | Before | After |
| --- | ---: | ---: |
| Server ready | 182.00 ms | 216.90 ms |
| Browser asset build | 3.74 ms | 37.20 ms |
| Local readiness HTTP response | 0.087 ms | 0.063 ms |
| Chromium navigation to usable UI | 431.08 ms | 271.03 ms |
| UI click through two animation frames | 69.40 ms | 73.20 ms |

UI values use seven fresh browser contexts. They include browser scheduling and are too small/noisy to establish an interaction-speed improvement. The HTTP readiness handler is a transport diagnostic, not an end-to-end provider or app query.

The local dependency bundle removes five script CDN requests and one stylesheet CDN request. The UI became usable sooner in this sample, while server startup and asset build increased. The old build only processed the app shell, leaving dependencies to CDNs; the new build includes React, Marked, DOMPurify, and common Highlight.js languages. This is an explicit offline/reproducibility tradeoff. UI interaction measured opening Settings; its small difference is within scheduling noise.

`bun run benchmark` repeats the startup/build/readiness measurements. `bun run test:browser` exercises real UI hydration, same-origin authorization, the Markdown sanitizer, project links, and the escaped fallback. Set `FORGE_CAPTURE_PREVIEW=1` to refresh the fictional demo screenshot. Chromium is driven through Node to match Playwright's supported process boundary.
