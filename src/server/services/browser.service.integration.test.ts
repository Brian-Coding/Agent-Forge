import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { browserService } from './browser.service';
import { getArtifactRoot } from './artifact-paths';

const runIntegration = process.env.RUN_BROWSER_INTEGRATION === '1';

describe.skipIf(!runIntegration)('browser service integration', () => {
  const workspaceId = `browser-smoke-${Date.now()}`;
  const qaSession = 'qa-smoke';
  const atlasSession = 'atlas-smoke';

  afterAll(async () => {
    await browserService.close();
  });

  test('runs statements once and isolates sessions', async () => {
    await browserService.navigate(
      workspaceId,
      'data:text/html,<title>QA Smoke</title><main id="app">ready</main>',
      qaSession,
    );
    await browserService.setViewport(workspaceId, 900, 600, qaSession);

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
});

