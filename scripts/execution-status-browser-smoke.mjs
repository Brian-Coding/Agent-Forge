// Isolated frontend replay. Run with Node for Playwright's Windows process boundary.
// All Agent Forge HTTP and WebSocket traffic is mocked; no live workers are used.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync(new URL('../src/client/index.html', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://status-smoke.test/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
    const body = url.pathname === '/api/ports' ? []
      : url.pathname === '/api/models' ? { providers: [] }
      : url.pathname === '/api/git-branch' ? { branch: 'fixture' } : {};
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(() => {
    window.__agent = {
      id: 'fixture', name: 'Planet incident fixture', cwd: 'C:/isolated-fixture',
      status: 'thinking', provider: 'codex', model: 'gpt-6-astra',
      workspaceId: 'workspace', referencePaths: [], createdAt: 1,
    };
    window.__live = {
      agentId: 'fixture', turnId: 'process', provider: 'codex', active: true,
      phase: 'thinking', thought: 'Repair published.', response: '', activity: null,
      startedAt: Date.now() - 5_340_000, lastProviderEventAt: Date.now() - 1_335_000,
      lastVisibleProgressAt: Date.now() - 1_335_000, revision: 100,
      providerTurn: { source: 'rollout', status: 'stopped', id: 'continuation', at: Date.now() - 1_335_000 },
    };
    class FakeSocket {
      static OPEN = 1;
      constructor() {
        this.readyState = 1;
        window.__socket = this;
        setTimeout(() => {
          this.onopen?.();
          this.emit({ type: 'agents_list', agents: [window.__agent] });
          this.emit({ type: 'workspaces_list', workspaces: [{
            id: 'workspace', name: 'Isolated status QA', cwd: 'C:/isolated-fixture',
            sortOrder: 0, gridColumns: 1, gridRows: 1, selectedAgentIds: ['fixture'],
            lockedAgentIds: [], createdAt: 1,
          }] });
          this.emit({ type: 'live_turn_state', state: window.__live });
        }, 10);
      }
      emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
      send(text) {
        const message = JSON.parse(text);
        if (message.type === 'ping') this.emit({ type: 'pong' });
        if (message.type === 'get_history') this.emit({ type: 'history', agentId: 'fixture', messages: [] });
      }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    window.WebSocket = FakeSocket;
  });

  await page.goto('http://status-smoke.test/');
  const header = page.locator('.panel-header .status-elapsed');
  const animation = () => page.locator('.panel-header .status-dot').evaluate(el => getComputedStyle(el).animationName);
  const update = patch => page.evaluate(patch => {
    window.__live = { ...window.__live, ...patch, revision: window.__live.revision + 1 };
    window.__socket.emit({ type: 'live_turn_state', state: window.__live });
  }, patch);

  await header.filter({ hasText: 'provider turn interrupted' }).waitFor();
  assert.match(await header.innerText(), /run still open/);
  assert.equal(await animation(), 'none');
  assert.equal(await page.locator('.workspace-active-dot').evaluate(el => getComputedStyle(el).animationName), 'none');
  if (process.env.STATUS_SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.STATUS_SMOKE_SCREENSHOT });

  for (const [status, label] of [['completed', 'Waiting'], ['failed', 'Failed']]) {
    await update({ providerTurn: { source: 'rollout', id: status, status, at: Date.now() } });
    await header.filter({ hasText: label }).waitFor();
    assert.equal(await animation(), 'none');
  }
  await update({
    providerTurn: { status: 'running', source: 'rollout', id: 'next', at: Date.now() },
    phase: 'transport', lastProviderEventAt: Date.now(),
  });
  await header.filter({ hasText: 'provider reconnecting' }).waitFor();
  assert.equal(await animation(), 'none');

  await update({ phase: 'tool', lastProviderEventAt: Date.now() });
  await header.filter({ hasText: 'Running tool' }).waitFor();
  assert.equal(await animation(), 'pulse');
  await update({ lastProviderEventAt: Date.now() - 700_000 });
  await header.filter({ hasText: 'Status uncertain' }).waitFor();
  assert.equal(await animation(), 'none');

  await page.evaluate(() => {
    window.__live = { ...window.__live, revision: 1, active: false };
    window.__agent = { ...window.__agent, status: 'idle', lastTurnOutcome: { status: 'completed', at: Date.now() } };
    window.__socket.close();
  });
  await header.filter({ hasText: 'disconnected' }).waitFor();
  await header.filter({ hasText: 'Completed' }).waitFor();
  assert.equal(await animation(), 'none');
  assert.deepEqual(errors, []);
  console.log('Browser PASS: stopped, waiting, failed, provider reconnect, active long tool, silent uncertainty, disconnect and completed hydration; no page errors.');
} finally {
  await browser.close();
}
