import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFreshTempDirectorySync, safeRemoveTree } from '../src/server/services/safe-filesystem.mjs';
import { killProcessTree, waitForProcessExit } from '../src/server/utils';

const root = resolve(import.meta.dir, '..');
const sampleCount = 7;
const requestsPerSample = 10;
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const samples: Array<{ startup_ms: number; build_ms: number; request_ms: number[] }> = [];

for (let i = 0; i < sampleCount; i++) {
  const state = createFreshTempDirectorySync({ prefix: 'forge-benchmark-', audit: false });
  let canRemoveState = true;
  try {
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const port = reservation.port!;
    await reservation.stop(true);
    const entry = join(state, 'entry.ts');
    await writeFile(entry, [
      `import { installOfflineDemoServices } from ${JSON.stringify(pathToFileURL(join(root, 'scripts/demo/offline-services.ts')).href)};`,
      'installOfflineDemoServices();',
      `const server = await import(${JSON.stringify(pathToFileURL(join(root, 'src/server/index.ts')).href)});`,
      'await Bun.stdin.text();',
      "await server.shutdown({ reason: 'benchmark complete' });",
    ].join('\n'));

    const startedAt = performance.now();
    const proc = Bun.spawn([process.execPath, entry], {
      cwd: state, detached: process.platform !== 'win32', stdin: 'pipe', stdout: 'ignore', stderr: 'ignore',
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        PORT: String(port), HOST: '127.0.0.1',
        AGENT_FORGE_MACHINE_ID: 'fictional-benchmark',
        AGENT_FORGE_ARTIFACT_ROOT: join(state, 'artifacts'),
        AGENT_FORGE_USAGE_SYNC_DIR: join(state, 'usage'),
      },
    });
    canRemoveState = false;
    let startupMs: number;
    const requests: number[] = [];
    try {
      const url = `http://127.0.0.1:${port}/api/harness/instructions`;
      let ready = false;
      while (performance.now() - startedAt < 15_000) {
        if (proc.exitCode !== null) throw new Error(`Benchmark server exited with code ${proc.exitCode}`);
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(500) });
          ready = response.ok;
          await response.text();
        } catch { /* Readiness polling includes connection failures during startup. */ }
        if (ready) break;
        await Bun.sleep(5);
      }
      if (!ready) throw new Error('Benchmark server did not become ready within 15 seconds');
      startupMs = performance.now() - startedAt;
      for (let n = 0; n < requestsPerSample; n++) {
        const start = performance.now();
        const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
        if (!response.ok) throw new Error(`Readiness request failed: ${response.status}`);
        await response.text();
        requests.push(performance.now() - start);
      }
    } finally {
      proc.stdin.end();
      const exit = await waitForProcessExit(proc, 5_000);
      if (exit.status !== 'exited') {
        const stopped = await killProcessTree(proc);
        canRemoveState = stopped.rootExited;
        if (!stopped.rootExited) throw new Error('Could not stop the benchmark child; temporary state retained');
        throw new Error('Benchmark server did not shut down cleanly');
      }
      canRemoveState = true;
      if (exit.exitCode !== 0) throw new Error(`Benchmark server exited with code ${exit.exitCode}`);
    }

    const buildStartedAt = performance.now();
    const build = await Bun.build({
      entrypoints: [join(root, 'src/client/vendor.ts')], target: 'browser', format: 'iife', minify: true,
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    });
    if (!build.success) throw new Error('Benchmark browser asset build failed');
    samples.push({ startup_ms: startupMs, build_ms: performance.now() - buildStartedAt, request_ms: requests });
  } finally {
    if (canRemoveState) await safeRemoveTree({
      targetPath: state, allowedRoot: dirname(state), expectedTargetName: /^forge-benchmark-/,
      reason: 'Remove disposable benchmark state', allowNonEmpty: true,
      mode: 'delete', permanent: true, audit: false,
    });
  }
}

console.log(JSON.stringify({
  measured_at: new Date().toISOString(), platform: process.platform, arch: process.arch, bun: Bun.version,
  mode: 'offline fixtures; provider discovery and usage sync disabled',
  sample_count: sampleCount, requests_per_sample: requestsPerSample,
  medians: {
    startup_ms: median(samples.map(sample => sample.startup_ms)),
    build_ms: median(samples.map(sample => sample.build_ms)),
    request_ms: median(samples.flatMap(sample => sample.request_ms)),
  },
  samples,
}, null, 2));
