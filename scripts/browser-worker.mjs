// Node-side Playwright worker.
// Spawned by the Bun server's browser.service. Listens on a random localhost
// port and exposes browser ops as JSON HTTP. Prints `READY:<port>\n` to
// stdout once it's listening so the parent knows where to talk.
//
// Why a separate Node process? Playwright's launch() hangs indefinitely on
// Bun on Windows due to child_process/IPC compat. Node runs it cleanly.

import { createServer } from 'node:http';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { chromium } from 'playwright';

const CONSOLE_LIMIT = 100;
const SCREENSHOT_TTL_MS = 60 * 60 * 1000;
const READY_TIMEOUT_MS = 5000;
const READY_DOM_QUIET_MS = 500;
const READY_POST_FILE_CHANGE_DELAY_MS = 500;

let browser = null;
const contexts = new Map(); // workspaceId -> { context, page, consoleEntries, lastFileChangeAt }

function screenshotsDir(workspaceId) {
  return path.join(os.tmpdir(), 'agent-forge-qa', workspaceId, 'screenshots');
}

async function ensureDir(dir) {
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

async function pruneOldScreenshots(dir) {
  if (!existsSync(dir)) return;
  const now = Date.now();
  try {
    const files = await readdir(dir);
    await Promise.all(files.map(async (f) => {
      try {
        const full = path.join(dir, f);
        const s = await stat(full);
        if (now - s.mtimeMs > SCREENSHOT_TTL_MS) await unlink(full);
      } catch {}
    }));
  } catch {}
}

function recordConsole(wsCtx, level, text) {
  wsCtx.consoleEntries.push({ level, text, timestamp: Date.now() });
  if (wsCtx.consoleEntries.length > CONSOLE_LIMIT) {
    wsCtx.consoleEntries.splice(0, wsCtx.consoleEntries.length - CONSOLE_LIMIT);
  }
}

async function ensureBrowser() {
  if (browser) return;
  // Headed by default so the user can watch the QA agent click around in
  // real time. slowMo paces each action enough to follow visually without
  // making tests painfully slow. Set BROWSER_HEADLESS=1 to suppress the
  // window (e.g. for CI or background runs).
  const headless = process.env.BROWSER_HEADLESS === '1';
  const slowMo = process.env.BROWSER_SLOWMO != null ? parseInt(process.env.BROWSER_SLOWMO, 10) : 250;
  browser = await chromium.launch({ headless, slowMo });
}

async function ensureContext(workspaceId) {
  if (contexts.has(workspaceId)) return contexts.get(workspaceId);
  await ensureBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const wsCtx = { context, page, consoleEntries: [], lastFileChangeAt: 0 };
  page.on('console', (msg) => recordConsole(wsCtx, msg.type() || 'log', msg.text()));
  page.on('pageerror', (err) => recordConsole(wsCtx, 'error', err.message));
  contexts.set(workspaceId, wsCtx);
  return wsCtx;
}

async function closeContext(workspaceId) {
  const wsCtx = contexts.get(workspaceId);
  if (!wsCtx) return;
  try { await wsCtx.context.close(); } catch {}
  contexts.delete(workspaceId);
}

async function shutdown() {
  for (const id of [...contexts.keys()]) await closeContext(id).catch(() => {});
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

// ============== HTTP handler ==============

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const handlers = {
  'GET /status': async (_req, _body, query) => {
    const id = query.workspaceId;
    const wsCtx = id ? contexts.get(id) : null;
    if (!wsCtx) return { running: false };
    return { running: true, url: wsCtx.page.url() };
  },

  'POST /navigate': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId);
    await wsCtx.page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { ok: true, url: wsCtx.page.url(), title: await wsCtx.page.title() };
  },

  'POST /screenshot': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId);
    const dir = screenshotsDir(body.workspaceId);
    await ensureDir(dir);
    pruneOldScreenshots(dir).catch(() => {});
    const filename = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const filePath = path.join(dir, filename);
    if (body.selector) {
      const el = await wsCtx.page.$(body.selector);
      if (!el) throw new Error(`Selector not found: ${body.selector}`);
      await el.screenshot({ path: filePath });
    } else {
      await wsCtx.page.screenshot({ path: filePath, fullPage: !!body.fullPage });
    }
    return { ok: true, path: filePath };
  },

  'POST /click': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId);
    await wsCtx.page.click(body.selector, { timeout: 10000 });
    return { ok: true };
  },

  'POST /type': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId);
    await wsCtx.page.fill(body.selector, body.text, { timeout: 10000 });
    return { ok: true };
  },

  'POST /wait-for-ready': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId);
    const start = Date.now();
    if (Date.now() - wsCtx.lastFileChangeAt < 2000) {
      await new Promise(r => setTimeout(r, READY_POST_FILE_CHANGE_DELAY_MS));
    }
    const networkIdle = wsCtx.page.waitForLoadState('networkidle', { timeout: READY_TIMEOUT_MS }).catch(() => {});
    const domQuiet = wsCtx.page.evaluate((quietMs) => new Promise((resolve) => {
      let timer = null;
      const reset = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { obs.disconnect(); resolve(); }, quietMs);
      };
      const obs = new MutationObserver(reset);
      obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      reset();
    }), READY_DOM_QUIET_MS).catch(() => {});
    const ceiling = new Promise(r => setTimeout(r, READY_TIMEOUT_MS));
    await Promise.race([Promise.all([networkIdle, domQuiet]), ceiling]);
    return { ok: true, duration: Date.now() - start };
  },

  'GET /console': async (_req, _body, query) => {
    const id = query.workspaceId;
    const wsCtx = id ? contexts.get(id) : null;
    return { entries: wsCtx ? [...wsCtx.consoleEntries] : [] };
  },

  'POST /console/clear': async (_req, body) => {
    const wsCtx = contexts.get(body.workspaceId);
    if (wsCtx) wsCtx.consoleEntries = [];
    return { ok: true };
  },

  'POST /context/close': async (_req, body) => {
    await closeContext(body.workspaceId);
    return { ok: true };
  },

  'POST /file-changed': async (_req, body) => {
    const wsCtx = contexts.get(body.workspaceId);
    if (wsCtx) wsCtx.lastFileChangeAt = Date.now();
    return { ok: true };
  },

  'POST /evaluate': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId);
    if (typeof body.script !== 'string') throw new Error('script (string) required');
    // page.evaluate runs the function in the page's window context. We wrap the
    // user-supplied script in a function so it can use `return` if desired, and
    // also handle bare expressions / statements transparently.
    const wrapped = `(async () => { try { return (${body.script}); } catch (e) { try { ${body.script}; return undefined; } catch (e2) { throw e2; } } })()`;
    const raw = await wsCtx.page.evaluate(wrapped);
    // Make sure result is JSON-serializable. Stringify-then-parse to coerce.
    let result;
    try { result = JSON.parse(JSON.stringify(raw === undefined ? null : raw)); }
    catch { result = String(raw); }
    return { ok: true, result };
  },

  'POST /shutdown': async () => {
    setImmediate(async () => {
      await shutdown();
      process.exit(0);
    });
    return { ok: true };
  },
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    const handler = handlers[key];
    if (!handler) return send(res, 404, { ok: false, error: `No handler for ${key}` });
    const body = (req.method === 'POST') ? await readJson(req) : {};
    const query = Object.fromEntries(url.searchParams);
    const result = await handler(req, body, query);
    send(res, 200, result);
  } catch (e) {
    send(res, 500, { ok: false, error: e?.message || String(e) });
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  console.log(`READY:${port}`);
});

// Exit if the parent dies (best-effort — works when stdin closes).
process.stdin.on('end', () => {
  shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown().finally(() => process.exit(0)); });
