# Performance measurements

Measured November 17, 2026, on Linux x86_64 with Bun 1.4.4. The [raw samples](performance-sample.json) come from `bun run benchmark`. These are development observations with offline fixtures, not capacity, live-provider, or cross-platform claims.

| Measurement | Median | Samples |
| --- | ---: | ---: |
| Server ready | 98.57 ms | 7 launches |
| Browser asset build | 26.48 ms | 7 builds |
| Local readiness HTTP response | 0.067 ms | 70 requests |

The benchmark launches the real server against fresh temporary state on an available loopback port. It installs the same offline discovery services as the demo: provider probing, model/limits network access, and usage sync are disabled. Startup ends after the first successful `/api/harness/instructions` response, polled every 5 ms. Each launch is followed by ten readiness requests and an in-memory, minified Bun build of `src/client/vendor.ts`. HTTP medians pool all 70 requests. Filesystem caches are not cleared and machine load is not controlled.

The readiness handler measures local transport, not an end-to-end provider query. Real startup with provider discovery enabled can take longer. This sample does not establish a before/after speed improvement. Browser navigation and interaction latency are not measured by this benchmark.

The local bundle serves React, Marked, DOMPurify, and common Highlight.js languages without a CDN. That adds startup/build work but makes the browser assets reproducible from the lockfile.

`bun run test:browser` checks real UI hydration, same-origin authorization, Markdown sanitization, project links, slash commands, and the escaped fallback. It uses offline provider discovery and fictional state. Chromium is driven through Node to match Playwright's process boundary. Set `FORGE_CAPTURE_PREVIEW=1` only when intentionally refreshing the fictional demo screenshot.
