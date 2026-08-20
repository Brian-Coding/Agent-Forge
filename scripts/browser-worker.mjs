// Node-side Playwright worker.
// Spawned by the Bun server's browser.service. Listens on a random localhost
// port and exposes browser ops as JSON HTTP. Prints `READY:<port>\n` to
// stdout once it's listening so the parent knows where to talk.
//
// Why a separate Node process? Playwright's launch() hangs indefinitely on
// Bun on Windows due to child_process/IPC compat. Node runs it cleanly.

import { createServer } from 'node:http';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { chromium } from 'playwright';
import {
  browserSessionKey,
  compileEvaluationScript,
  normalizeBrowserSessionId,
  singleFlight,
  withOperationTimeout,
} from './browser-worker-core.mjs';
import { safeRemoveFile, safeRemoveTree } from '../src/server/services/safe-filesystem.mjs';

const CONSOLE_LIMIT = 100;
const NETWORK_LIMIT = 200;
const SCREENSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const READY_TIMEOUT_MS = 5000;
const READY_DOM_QUIET_MS = 500;
const READY_POST_FILE_CHANGE_DELAY_MS = 500;
const EVALUATE_TIMEOUT_MS = 15_000;
const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

// Idle cleanup: contexts unused for longer than CONTEXT_IDLE_MS get closed
// during the periodic sweep. Prevents BrowserContexts from accumulating
// game state, retained DOM, WebGL textures, etc. across long sessions.
const CONTEXT_IDLE_MS = 10 * 60 * 1000;     // 10 minutes
const CONTEXT_SWEEP_INTERVAL_MS = 60 * 1000; // check every 1 minute
const MEMORY_WARN_RSS_MB = 2048;             // warn if worker RSS exceeds 2 GB
const MEMORY_CHECK_INTERVAL_MS = 60 * 1000;

let browser = null;
let browserGeneration = 0;
let shuttingDown = false;
let shutdownPromise = null;
const browserCreations = new Map();
// JSON([workspaceId, browserSessionId]) -> isolated Playwright state.
const contexts = new Map();
const contextCreations = new Map();
const contextGenerations = new Map();

const artifactRoot = path.resolve(
  process.env.AGENT_FORGE_ARTIFACT_ROOT
    || (process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'AgentForge', 'artifacts')
      : path.join(os.homedir(), '.local', 'share', 'agent-forge', 'artifacts')),
);

function safePathSegment(value, fallback) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  return safe || fallback;
}

function screenshotsDir(workspaceId, runId, browserSessionId) {
  return path.join(
    artifactRoot,
    'qa',
    safePathSegment(workspaceId, 'workspace'),
    safePathSegment(runId, safePathSegment(browserSessionId, 'adhoc')),
    'screenshots',
  );
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
        if (now - s.mtimeMs > SCREENSHOT_TTL_MS) {
          await safeRemoveFile({
            targetPath: full,
            allowedRoot: dir,
            reason: 'Remove an expired Agent Forge QA screenshot',
            mode: 'delete',
            permanent: true,
            expectedTargetName: /\.png$/i,
          });
        }
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

async function pruneOldQaRunDirectories(workspaceRoot, currentRunRoot) {
  if (!existsSync(workspaceRoot)) return;
  const now = Date.now();
  try {
    const entries = await readdir(workspaceRoot, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(entry.name)) return;
      const full = path.join(workspaceRoot, entry.name);
      if (path.resolve(full) === path.resolve(currentRunRoot)) return;
      try {
        const info = await stat(full);
        if (now - info.mtimeMs > SCREENSHOT_TTL_MS) {
          await safeRemoveTree({
            targetPath: full,
            allowedRoot: workspaceRoot,
            reason: 'Remove an expired generated Agent Forge QA run artifact directory',
            mode: 'delete',
            permanent: true,
            allowNonEmpty: true,
            allowedTopLevelNames: ['screenshots'],
            maxEntries: 50_000,
            expectedTargetName: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/,
            protectedPaths: [artifactRoot],
          });
        }
      } catch {}
    }));
  } catch {}
}

function recordNetwork(wsCtx, entry) {
  wsCtx.networkEntries.push({ ...entry, timestamp: Date.now() });
  if (wsCtx.networkEntries.length > NETWORK_LIMIT) {
    wsCtx.networkEntries.splice(0, wsCtx.networkEntries.length - NETWORK_LIMIT);
  }
}

async function ensureBrowser() {
  if (shuttingDown) throw new Error('Browser worker is shutting down');
  if (browser) return browser;
  // Headed by default so the user can watch the QA agent click around in
  // real time. slowMo paces each action enough to follow visually without
  // making tests painfully slow. Set BROWSER_HEADLESS=1 to suppress the
  // window (e.g. for CI or background runs).
  const headless = process.env.BROWSER_HEADLESS === '1';
  const parsedSlowMo = process.env.BROWSER_SLOWMO != null ? parseInt(process.env.BROWSER_SLOWMO, 10) : 250;
  const slowMo = Number.isFinite(parsedSlowMo) && parsedSlowMo >= 0 ? Math.min(parsedSlowMo, 10_000) : 250;
  return singleFlight(browserCreations, 'browser', async () => {
    if (browser) return browser;
    const generation = browserGeneration;
    const launched = await chromium.launch({ headless, slowMo });
    if (shuttingDown || generation !== browserGeneration) {
      await launched.close().catch(() => {});
      throw new Error('Browser launch was cancelled by shutdown');
    }
    browser = launched;
    launched.on('disconnected', () => {
      if (browser !== launched) return;
      browser = null;
      for (const key of contexts.keys()) {
        contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1);
      }
      contexts.clear();
    });
    return launched;
  });
}

function getContext(workspaceId, browserSessionId) {
  const wsCtx = contexts.get(browserSessionKey(workspaceId, browserSessionId));
  if (wsCtx) wsCtx.lastUsedAt = Date.now();
  return wsCtx;
}

async function ensureContext(workspaceId, browserSessionId) {
  if (shuttingDown) throw new Error('Browser worker is shutting down');
  const normalizedSessionId = normalizeBrowserSessionId(browserSessionId);
  const key = browserSessionKey(workspaceId, normalizedSessionId);
  const existing = contexts.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const generation = contextGenerations.get(key) ?? 0;
  return singleFlight(contextCreations, key, async () => {
    const browserInstance = await ensureBrowser();
    const context = await browserInstance.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      if (shuttingDown || generation !== (contextGenerations.get(key) ?? 0)) {
        throw new Error('Browser context creation was cancelled');
      }
      const wsCtx = {
        workspaceId,
        browserSessionId: normalizedSessionId,
        context,
        page,
        consoleEntries: [],
        networkEntries: [],
        lastFileChangeAt: 0,
        lastUsedAt: Date.now(),
      };
      page.on('console', (msg) => recordConsole(wsCtx, msg.type() || 'log', msg.text()));
      page.on('pageerror', (err) => recordConsole(wsCtx, 'error', err.message));
      page.on('response', (response) => {
        recordNetwork(wsCtx, {
          kind: 'response',
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          ok: response.ok(),
        });
      });
      page.on('requestfailed', (request) => {
        recordNetwork(wsCtx, {
          kind: 'requestfailed',
          url: request.url(),
          method: request.method(),
          status: null,
          ok: false,
          error: request.failure()?.errorText || 'request failed',
        });
      });
      contexts.set(key, wsCtx);
      return wsCtx;
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }
  });
}

// Periodic sweep: close contexts that haven't been used in a while. Prevents
// memory creep from idle workspaces that opened a context once + never came
// back. Runs forever while the worker is alive.
const idleSweepTimer = setInterval(async () => {
  const now = Date.now();
  for (const [key, wsCtx] of contexts.entries()) {
    if (now - wsCtx.lastUsedAt > CONTEXT_IDLE_MS) {
      console.warn(`[browser-worker] closing idle context for ${wsCtx.workspaceId}/${wsCtx.browserSessionId} (idle ${Math.round((now - wsCtx.lastUsedAt) / 60000)}m)`);
      contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1);
      contexts.delete(key);
      try { await wsCtx.context.close(); } catch {}
    }
  }
}, CONTEXT_SWEEP_INTERVAL_MS);
idleSweepTimer.unref?.();

// Periodic memory check. Worker should not exceed a few hundred MB normally.
// 2 GB indicates a leak or accumulated state. Warn loudly so the operator
// notices in stdout and can choose to recycle the worker manually.
const memoryCheckTimer = setInterval(() => {
  const rss = process.memoryUsage().rss;
  const rssMb = Math.round(rss / 1024 / 1024);
  if (rssMb > MEMORY_WARN_RSS_MB) {
    console.warn(`[browser-worker] memory warning: RSS ${rssMb} MB exceeds ${MEMORY_WARN_RSS_MB} MB threshold (${contexts.size} active contexts). Consider recycling the worker.`);
  }
}, MEMORY_CHECK_INTERVAL_MS);
memoryCheckTimer.unref?.();

async function closeContext(workspaceId, browserSessionId) {
  if (browserSessionId != null && browserSessionId !== '') {
    const key = browserSessionKey(workspaceId, browserSessionId);
    contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1);
    const wsCtx = contexts.get(key);
    if (!wsCtx) return;
    contexts.delete(key);
    try { await wsCtx.context.close(); } catch {}
    return;
  }

  const keys = new Set([...contexts.keys(), ...contextCreations.keys()]);
  for (const key of keys) {
    let owner;
    try { owner = JSON.parse(key)?.[0]; } catch { continue; }
    if (owner !== workspaceId) continue;
    contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1);
    const wsCtx = contexts.get(key);
    contexts.delete(key);
    if (!wsCtx) continue;
    try { await wsCtx.context.close(); } catch {}
  }
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  browserGeneration++;
  for (const key of new Set([...contexts.keys(), ...contextCreations.keys()])) {
    contextGenerations.set(key, (contextGenerations.get(key) ?? 0) + 1);
  }
  shutdownPromise = (async () => {
    const activeContexts = [...contexts.values()];
    contexts.clear();
    await Promise.allSettled(activeContexts.map(wsCtx => wsCtx.context.close()));
    const pending = [...contextCreations.values(), ...browserCreations.values()];
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    }
    const activeBrowser = browser;
    browser = null;
    if (activeBrowser) await activeBrowser.close().catch(() => {});
  })();
  return shutdownPromise;
}

// ============== HTTP handler ==============

async function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let rejected = false;
    req.on('data', (c) => {
      totalBytes += c.length;
      if (totalBytes > JSON_BODY_LIMIT_BYTES) {
        if (!rejected) {
          rejected = true;
          reject(new Error(`JSON body exceeds ${JSON_BODY_LIMIT_BYTES} bytes`));
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (rejected) return;
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
    const wsCtx = id ? getContext(id, query.browserSessionId) : null;
    if (!wsCtx) return { running: false };
    return {
      running: true,
      url: wsCtx.page.url(),
      title: await wsCtx.page.title().catch(() => ''),
      browserSessionId: wsCtx.browserSessionId,
    };
  },

  'POST /navigate': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId, body.browserSessionId);
    await wsCtx.page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { ok: true, url: wsCtx.page.url(), title: await wsCtx.page.title() };
  },

  'POST /screenshot': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId, body.browserSessionId);
    // Two destination modes:
    //   - body.outDir (absolute path): write directly to this directory.
    //     Used by the Atlas Agent so screenshots land in
    //     <projectCwd>/docs/ui-atlas/shots/ with no tmpdir round-trip.
    //     The Bun server validates this path before forwarding.
    //   - default: stable Agent Forge artifacts under qa/<workspace>/<run>/screenshots/.
    //     Used by the QA Tester so evidence survives a server restart.
    let dir;
    if (typeof body.outDir === 'string' && body.outDir.trim()) {
      dir = body.outDir.trim();
      await ensureDir(dir);
    } else {
      dir = screenshotsDir(body.workspaceId, body.runId, wsCtx.browserSessionId);
      await ensureDir(dir);
      pruneOldScreenshots(dir).catch(() => {});
      pruneOldQaRunDirectories(path.dirname(path.dirname(dir)), path.dirname(dir)).catch(() => {});
    }
    let filename;
    if (typeof body.name === 'string' && body.name.trim()) {
      const safe = body.name.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\.png$/i, '').slice(0, 120);
      filename = (safe || `screenshot-${Date.now()}`) + '.png';
    } else {
      filename = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    }
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
    const wsCtx = await ensureContext(body.workspaceId, body.browserSessionId);
    await wsCtx.page.click(body.selector, { timeout: 10000 });
    return { ok: true };
  },

  'POST /type': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId, body.browserSessionId);
    await wsCtx.page.fill(body.selector, body.text, { timeout: 10000 });
    return { ok: true };
  },

  'POST /wait-for-ready': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId, body.browserSessionId);
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
    const wsCtx = id ? getContext(id, query.browserSessionId) : null;
    return { entries: wsCtx ? [...wsCtx.consoleEntries] : [] };
  },

  'POST /console/clear': async (_req, body) => {
    const wsCtx = getContext(body.workspaceId, body.browserSessionId);
    if (wsCtx) wsCtx.consoleEntries = [];
    return { ok: true };
  },

  'GET /network': async (_req, _body, query) => {
    const id = query.workspaceId;
    const wsCtx = id ? getContext(id, query.browserSessionId) : null;
    return { entries: wsCtx ? [...wsCtx.networkEntries] : [] };
  },

  'POST /network/clear': async (_req, body) => {
    const wsCtx = getContext(body.workspaceId, body.browserSessionId);
    if (wsCtx) wsCtx.networkEntries = [];
    return { ok: true };
  },

  'POST /viewport': async (_req, body) => {
    const width = Number(body.width);
    const height = Number(body.height);
    if (!Number.isInteger(width) || width < 320 || width > 7680) {
      throw new Error('viewport width must be an integer from 320 to 7680');
    }
    if (!Number.isInteger(height) || height < 240 || height > 4320) {
      throw new Error('viewport height must be an integer from 240 to 4320');
    }
    const wsCtx = await ensureContext(body.workspaceId, body.browserSessionId);
    await wsCtx.page.setViewportSize({ width, height });
    return { ok: true, width, height };
  },

  'POST /context/close': async (_req, body) => {
    await closeContext(body.workspaceId, body.browserSessionId);
    return { ok: true };
  },

  'POST /file-changed': async (_req, body) => {
    for (const wsCtx of contexts.values()) {
      if (wsCtx.workspaceId === body.workspaceId) wsCtx.lastFileChangeAt = Date.now();
    }
    return { ok: true };
  },

  'POST /evaluate': async (_req, body) => {
    const wsCtx = await ensureContext(body.workspaceId, body.browserSessionId);
    if (typeof body.script !== 'string') throw new Error('script (string) required');
    const wrapped = compileEvaluationScript(body.script);
    const raw = await withOperationTimeout(
      wsCtx.page.evaluate(wrapped),
      EVALUATE_TIMEOUT_MS,
      'Browser evaluation',
      () => closeContext(body.workspaceId, wsCtx.browserSessionId),
    );
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
