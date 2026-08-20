import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserService } from './browser.service';
import { getArtifactRoot } from './artifact-paths';
import { terminateNodeChildProcess } from './node-child-process';
import { persistenceService } from './persistence.service';

const runIntegration = process.env.RUN_BROWSER_INTEGRATION === '1';

describe.skipIf(!runIntegration)('browser service integration', () => {
  const workspaceId = `browser-smoke-${Date.now()}`;
  const qaSession = 'qa-smoke';
  const atlasSession = 'atlas-smoke';
  const artifactRoot = join(tmpdir(), `agent-forge-browser-smoke-${randomUUID()}`);
  let originalArtifactRoot: string | undefined;

  beforeAll(() => {
    originalArtifactRoot = process.env.AGENT_FORGE_ARTIFACT_ROOT;
    process.env.AGENT_FORGE_ARTIFACT_ROOT = artifactRoot;
  });

  afterAll(async () => {
    await browserService.close();
    if (originalArtifactRoot === undefined) delete process.env.AGENT_FORGE_ARTIFACT_ROOT;
    else process.env.AGENT_FORGE_ARTIFACT_ROOT = originalArtifactRoot;
    await rm(artifactRoot, { recursive: true, force: true });
  });

  test('runs statements once and isolates sessions', async () => {
    await Promise.all([browserService.launch(), browserService.launch()]);
    await browserService.navigate(
      workspaceId,
      `data:text/html,${encodeURIComponent([
        '<title>QA Smoke</title>',
        '<main id="app">ready</main>',
        '<input id="name">',
        '<button id="save" onclick="document.body.dataset.saved = document.querySelector(\'#name\').value; console.warn(\'saved\')">Save</button>',
      ].join(''))}`,
      qaSession,
    );
    await browserService.setViewport(workspaceId, 900, 600, qaSession);

    await browserService.type(workspaceId, '#name', 'Ada Lovelace', qaSession);
    await browserService.click(workspaceId, '#save', qaSession);
    expect(await browserService.evaluate(workspaceId, 'document.body.dataset.saved', qaSession)).toBe('Ada Lovelace');
    expect((await browserService.getConsoleOutput(workspaceId, qaSession)).some(entry => entry.text.includes('saved'))).toBe(true);
    await browserService.clearConsole(workspaceId, qaSession);
    expect(await browserService.getConsoleOutput(workspaceId, qaSession)).toEqual([]);

    expect(await browserService.evaluate(workspaceId, 'const n = 3; return n * 4;', qaSession)).toBe(12);

    await expect(browserService.evaluate(
      workspaceId,
      `(() => { window.__exactlyOnce = (window.__exactlyOnce || 0) + 1; throw new Error('expected'); })()`,
      qaSession,
    )).rejects.toThrow('expected');
    expect(await browserService.evaluate(workspaceId, 'window.__exactlyOnce', qaSession)).toBe(1);

    expect(await browserService.evaluate(workspaceId, 'window.__exactlyOnce ?? null', atlasSession)).toBeNull();
    const qaStatus = await browserService.getStatus(workspaceId, qaSession);
    const atlasStatus = await browserService.getStatus(workspaceId, atlasSession);
    expect(qaStatus.url).toStartWith('data:text/html');
    expect(atlasStatus.url).toBe('about:blank');

    await browserService.notifyFileChanged(workspaceId);
    expect((await browserService.waitForReady(workspaceId, qaSession)).duration).toBeGreaterThanOrEqual(0);
    await browserService.clearNetwork(workspaceId, qaSession);
    expect(await browserService.getNetworkOutput(workspaceId, qaSession)).toEqual([]);

    await browserService.closeContext(workspaceId, qaSession);
    expect(await browserService.getStatus(workspaceId, qaSession)).toEqual({ running: false });
    expect((await browserService.getStatus(workspaceId, atlasSession)).running).toBe(true);
  }, 60_000);

  test('stores run screenshots in the stable artifact root', async () => {
    const screenshot = await browserService.screenshot(workspaceId, {
      browserSessionId: qaSession,
      runId: 'qa-run-smoke',
      name: 'landing',
    });
    expect(screenshot.startsWith(getArtifactRoot())).toBe(true);
    expect(existsSync(screenshot)).toBe(true);
  }, 30_000);

  test('recovers after an unexpected worker-tree exit and coalesces concurrent cleanup', async () => {
    await browserService.launch();
    const proc = (globalThis as any).__browserWorkerState?.proc;
    expect(proc?.pid).toBeNumber();
    const pid = proc.pid as number;
    expect(persistenceService.getActivePids().has(pid)).toBe(true);

    await terminateNodeChildProcess(proc);
    const deadline = Date.now() + 5_000;
    while (browserService.isRunning() && Date.now() < deadline) await Bun.sleep(10);
    expect(browserService.isRunning()).toBe(false);
    expect(persistenceService.getActivePids().has(pid)).toBe(false);

    await browserService.navigate(workspaceId, 'data:text/html,<title>Recovered</title>', 'recovered');
    expect((await browserService.getStatus(workspaceId, 'recovered')).title).toBe('Recovered');
    await Promise.all([browserService.close(), browserService.close(), browserService.close()]);
    expect(browserService.isRunning()).toBe(false);
  }, 60_000);
});

