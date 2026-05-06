// Smoke test for browser.service.ts
// Run: bun scripts/smoke-browser.ts
// Verifies: launch -> ensureContext -> navigate -> waitForReady -> screenshot -> console -> close
import { browserService } from '../src/server/services/browser.service';

const WS = 'smoke-test-ws';
const URL = 'https://example.com';

async function main() {
  const t0 = Date.now();
  console.log('[smoke] launching...');
  await browserService.launch();
  console.log(`[smoke] running=${browserService.isRunning()}`);

  console.log(`[smoke] navigate -> ${URL}`);
  const nav = await browserService.navigate(WS, URL);
  console.log('[smoke] nav result:', nav);

  console.log('[smoke] waitForReady...');
  const ready = await browserService.waitForReady(WS);
  console.log('[smoke] ready:', ready);

  console.log('[smoke] screenshot fullPage...');
  const fullPath = await browserService.screenshot(WS, { fullPage: true });
  console.log('[smoke] full-page saved:', fullPath);

  console.log('[smoke] screenshot selector h1...');
  const elPath = await browserService.screenshot(WS, { selector: 'h1' });
  console.log('[smoke] h1 saved:', elPath);

  console.log('[smoke] status:', await browserService.getStatus(WS));

  console.log('[smoke] evaluate page.title via page.evaluate...');
  const title = await browserService.evaluate(WS, 'document.title');
  console.log('[smoke] evaluate result:', title);

  console.log('[smoke] evaluate state-style mutation (does it round-trip?)');
  await browserService.evaluate(WS, "window.__smokeFlag = 'hello-from-evaluate'");
  const readBack = await browserService.evaluate(WS, 'window.__smokeFlag');
  console.log('[smoke] readBack:', readBack);

  console.log('[smoke] console output:', (await browserService.getConsoleOutput(WS)).slice(0, 5));

  console.log('[smoke] closing...');
  await browserService.close();
  console.log(`[smoke] OK in ${Date.now() - t0}ms`);
}

main().catch(err => {
  console.error('[smoke] FAILED:', err);
  process.exit(1);
});
