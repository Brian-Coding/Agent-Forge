import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {checkComposerFocus} from '../src/client/composer-focus.browser.mjs';
const origin=process.argv[2];
const browser=await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const external = []; page.on('request', req => { if (!req.url().startsWith(origin)) external.push(new URL(req.url()).origin); });
  await page.route('**/api/ports', route => route.fulfill({ json: { ports: [] } }));
  await page.goto(origin); await page.getByText('Search is ready', { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => typeof window.DOMPurify.sanitize), 'function');
  const sanitized = await page.evaluate(() => window.renderMarkdown('<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))\n[local](file:///demo/acme/notes%20list.md)\n[posix](/demo/acme/readme.md)\n[win](C:/demo/readme.md)', 'demo-0'));
  assert.ok(!sanitized.includes('onerror') && !sanitized.includes('javascript:'));
  assert.equal((sanitized.match(/api\/project-file/g) || []).length, 3);
  const filePaths = await page.evaluate(html => [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a[href]')].map(a => new URL(a.href, location.origin).searchParams.get('path')), sanitized);
  assert.ok(filePaths.includes('/demo/acme/notes list.md'));
  assert.equal(await page.evaluate(() => window.projectFilePathFromHref('file:///demo/caf%C3%A9.md')), '/demo/café.md');
  await page.evaluate(() => { const value=window.DOMPurify; window.DOMPurify=null; const html=window.renderMarkdown('<img onerror=alert(1)>'); window.DOMPurify=value; if(!html.includes('&lt;img')) throw new Error('Unsafe fallback'); });
  // Actual UI has a capability-bearing WebSocket and hydrates the fictional workspace.
  assert.ok((await page.textContent('body'))?.includes('Acme Notes'));
  await checkComposerFocus(page);
  // Exercise the bundled catalog through the real composer, without submitting.
  const composer = page.locator('.terminal-panel textarea').first();
  await composer.fill('/diff-ch');
  await page.locator('.slash-autocomplete-item').filter({ hasText: '/diff-check' }).waitFor();
  await composer.press('Tab');
  assert.equal(await composer.inputValue(), await page.evaluate(() => window.forgeSlashCommands.find(c => c.command === 'diff-check').promptTemplate));
  await composer.fill('/task-m');
  await composer.press('Escape');
  assert.equal(await composer.inputValue(), '');
  await composer.fill('');
  await page.getByTitle('Slash Commands', { exact: true }).click();
  assert.equal(await page.locator('.command-item').count(), 8);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('.command-item').filter({ hasText: '/pr-notes' }).click();
  await page.getByText('Copied!', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), await page.evaluate(() => window.forgeSlashCommands.find(c => c.command === 'pr-notes').promptTemplate));
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click();
  assert.equal((await fetch(origin + '/api/ports/kill', { method: 'POST', body: '{}' })).status, 403);
  const attacker = createServer((_req,res)=>{res.end('<!doctype html><title>Other local page</title>')});
  await new Promise(resolve=>attacker.listen(0,'127.0.0.1',resolve));
  try {
    const other = await browser.newPage(); await other.goto(`http://127.0.0.1:${attacker.address().port}`);
    const opened = await other.evaluate(url => new Promise(resolve => { const ws=new WebSocket(url); ws.onopen=()=>{ws.close();resolve(true)};ws.onerror=()=>resolve(false); }), origin.replace('http:', 'ws:'));
    assert.equal(opened,false); await other.close();
  } finally { await new Promise(resolve=>attacker.close(resolve)); }
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  if (process.argv[3] === 'capture') {
    await mkdir(resolve('docs/images'), { recursive: true });
    await page.screenshot({ path: resolve('docs/images/agent-forge.png') });
  }
  console.log('PASS: authorized UI, two-pane composer focus, cross-port browser rejection, local dependencies, Markdown sanitization, POSIX/file/Windows links, escaped fallback');

} finally { await browser.close(); }
