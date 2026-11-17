import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
const origin = process.argv[2];
const previewPort = Number(process.argv[4]);
const media = process.argv[3] === 'media';
const scratch = await mkdtemp(join(tmpdir(), 'forge-record-'));
const output = resolve(import.meta.dirname, '../../docs/images');
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...(media ? { recordVideo: { dir: scratch, size: { width: 1440, height: 900 } } } : {}) });
  const page = await context.newPage();
  const recordingStartedAt = performance.now();
  // Keep local machine inventory and provider account discovery out of demo UI.
  // The remaining port entry is the real demo preview, not invented data.
  await page.route('**/api/ports', async route => {
    const response = await route.fetch(); const body = await response.json();
    await route.fulfill({ json: { ...body, ports: (body.ports ?? []).filter(port => port.port === previewPort) } });
  });
  await page.route('**/api/models*', route => route.fulfill({ json: { providers: [] } }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByText('Acme Notes · scripted demo', { exact: true }).first().waitFor();
  const trimStart = (performance.now() - recordingStartedAt) / 1000;
  await page.waitForTimeout(media ? 1000 : 0);
  await page.locator('.terminal-panel textarea').nth(0).fill('Inspect search behavior and hand off the fictional preview.');
  await page.locator('.terminal-panel textarea').nth(0).press('Enter');
  await page.locator('.terminal-panel textarea').nth(1).fill('Run the fixture checks and prepare a human review checklist.');
  await page.locator('.terminal-panel textarea').nth(1).press('Enter');
  await page.getByText('Search handoff', { exact: true }).waitFor();
  await page.getByText('Verification handoff', { exact: true }).waitFor();
  assert.ok((await page.textContent('body')).includes('cost unknown'));
  await page.waitForTimeout(media ? 2500 : 100);
  await page.getByTitle('Show machine ports').click();
  await page.locator('.sidebar-port-number').filter({ hasText: ':' + previewPort }).waitFor();
  await page.waitForFunction(() => document.body.textContent.includes('pass 3'));
  assert.ok((await (await fetch(`http://127.0.0.1:${previewPort}`)).text()).includes('Fictional preview for the scripted Forge demo.'));
  assert.deepEqual(errors, []);
  if (media) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'forge-demo.png') });
    await page.waitForTimeout(4500);
  }
  const video = page.video();
  await context.close();
  if (media) {
    const source = await video.path();
    for (const [file, args] of [
      ['forge-demo.mp4', ['-vf', 'scale=1280:-2', '-c:v', 'libx264', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']],
      ['forge-demo.gif', ['-filter_complex', '[0:v]fps=8,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer']]
    ]) {
      const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(trimStart), '-i', source, ...args, join(output, file)]);
      assert.equal(result.status, 0, result.stderr?.toString());
    }
  }
  console.log('PASS: two scripted agents, actual terminal tests, demo preview port, unknown usage and clean UI');
} finally { await browser.close(); await rm(scratch, { recursive: true, force: true }); }
