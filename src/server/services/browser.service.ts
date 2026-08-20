// Browser service — Bun-side client to the Node Playwright worker.
//
// Why split: Playwright + Bun + Windows hangs on launch (Bun's
// child_process / IPC compat doesn't fully emulate Node's behavior, which
// Playwright depends on). The actual Playwright work runs in a Node
// subprocess; this service just spawns it and forwards calls over HTTP.

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { persistenceService } from './persistence.service';
import { getArtifactRoot } from './artifact-paths';
import { terminateNodeChildProcess, waitForNodeChildExit } from './node-child-process';
import { fetchWithTimeout, readJsonResponseWithTimeout } from './external-io';

interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  timestamp: number;
}

export interface NetworkEntry {
  kind: 'response' | 'requestfailed';
  url: string;
  method: string;
  status: number | null;
  ok: boolean;
  error?: string;
  timestamp: number;
}

const WORKER_SCRIPT = path.resolve(import.meta.dir, '../../../scripts/browser-worker.mjs');
const WORKER_READY_TIMEOUT_MS = 30_000;
const WORKER_FETCH_TIMEOUT_MS = 30_000;

interface WorkerState {
  proc: ChildProcess | null;
  port: number | null;
  ready: Promise<void> | null;
  closing: Promise<void> | null;
}

const BROWSER_WORKER_ENV_KEYS = new Set([
  'path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir',
  'home', 'userprofile', 'localappdata', 'appdata', 'lang', 'display',
  'wayland_display', 'xauthority', 'dbus_session_bus_address',
  'playwright_browsers_path', 'playwright_skip_browser_download',
  'browser_headless', 'browser_slowmo', 'http_proxy', 'https_proxy', 'no_proxy',
  'node_extra_ca_certs', 'agent_forge_safe_fs_dry_run',
]);

/** The browser worker needs OS/Playwright settings, not provider/API secrets. */
export function buildBrowserWorkerEnv(
  source: NodeJS.ProcessEnv,
  artifactRoot = getArtifactRoot(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toLowerCase();
    if (typeof value === 'string'
      && (BROWSER_WORKER_ENV_KEYS.has(normalized)
        || normalized.startsWith('lc_')
        || normalized.startsWith('xdg_'))) {
      env[key] = value;
    }
  }
  env.AGENT_FORGE_ARTIFACT_ROOT = artifactRoot;
  return env;
}

// HMR-safe state — survives `bun --hot` reloads
const state: WorkerState = (globalThis as any).__browserWorkerState ??= {
  proc: null,
  port: null,
  ready: null,
  closing: null,
};

function workerUrl(pathname: string): string {
  if (state.port == null) throw new Error('Browser worker is not running');
  return `http://127.0.0.1:${state.port}${pathname}`;
}

async function workerFetch(
  method: 'GET' | 'POST',
  pathname: string,
  body?: unknown,
  timeoutMs = WORKER_FETCH_TIMEOUT_MS,
): Promise<any> {
  if (state.ready) await state.ready;
  if (state.port == null) throw new Error('Browser worker is not running');
  const init: RequestInit = { method };
  if (method === 'POST') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const label = `Browser worker ${method} ${pathname.split('?')[0]}`;
  const startedAt = Date.now();
  try {
    const res = await fetchWithTimeout(workerUrl(pathname), init, timeoutMs, label);
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt));
    const json = await readJsonResponseWithTimeout(res, 4 * 1024 * 1024, remainingMs, label);
    if (!res.ok || (json && typeof json === 'object' && 'ok' in json && (json as any).ok === false)) {
      const msg = (json as any)?.error || `worker returned HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  } catch (error) {
    throw error;
  }
}

export function parseWorkerReadyPort(output: string): number | null {
  const match = output.match(/(?:^|\r?\n)READY:(\d+)(?:\r?\n|$)/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

async function spawnWorker(): Promise<void> {
  if (state.closing) await state.closing;
  if (state.ready) return state.ready;

  state.ready = new Promise<void>((resolve, reject) => {
    const proc = spawn('node', [WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: buildBrowserWorkerEnv(process.env),
    });
    state.proc = proc;
    let pidTracked = false;
    if (proc.pid) {
      pidTracked = true;
      persistenceService.trackPid(proc.pid);
    }

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        void terminateNodeChildProcess(proc).finally(() => {
          if (state.proc === proc) {
            state.proc = null;
            state.port = null;
            state.ready = null;
          }
          reject(new Error(`Browser worker did not become ready within ${WORKER_READY_TIMEOUT_MS}ms`));
        });
      }
    }, WORKER_READY_TIMEOUT_MS);

    let stdoutBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      // Look for READY:<port>\n
      const readyPort = parseWorkerReadyPort(stdoutBuf);
      if (readyPort !== null && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        state.port = readyPort;
        resolve();
      }
      if (stdoutBuf.length > 64_000) stdoutBuf = stdoutBuf.slice(-64_000);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      // Surface worker errors to the server log.
      const text = chunk.toString('utf8');
      if (text.trim()) console.error('[browser-worker]', text.trimEnd());
    });

    proc.on('exit', (code, signal) => {
      if (proc.pid && pidTracked) {
        pidTracked = false;
        persistenceService.untrackPid(proc.pid);
      }
      const wasRunning = state.proc === proc;
      if (wasRunning) {
        state.proc = null;
        state.port = null;
        state.ready = null;
      }
      if (wasRunning && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Browser worker exited before ready (code=${code}, signal=${signal})`));
      } else if (wasRunning) {
        console.warn(`[browser-worker] exited (code=${code}, signal=${signal})`);
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (state.proc === proc) {
          state.proc = null;
          state.port = null;
          state.ready = null;
        }
        reject(err);
      } else {
        console.error('[browser-worker] process error:', err);
      }
    });
  });

  return state.ready;
}

export const browserService = {
  // ============== Lifecycle ==============

  async launch(): Promise<void> {
    await spawnWorker();
  },

  async close(): Promise<void> {
    if (state.closing) return state.closing;
    const proc = state.proc;
    if (!proc) return;
    const closing = (async () => {
      // Ask the worker to shut down cleanly, verify its root exited, then
      // terminate the entire process tree if graceful cleanup stalls.
      try {
        await workerFetch('POST', '/shutdown', undefined, 3000);
      } catch { /* worker may already be down */ }
      if (state.proc !== proc) return;
      if (!await waitForNodeChildExit(proc, 1000)) {
        await terminateNodeChildProcess(proc);
      }
      if (state.proc === proc) {
        // An unconfirmed process remains in pids.json for startup recovery,
        // but must not block a replacement worker or receive new requests.
        state.proc = null;
        state.port = null;
        state.ready = null;
      }
    })();
    state.closing = closing;
    try {
      await closing;
    } finally {
      if (state.closing === closing) state.closing = null;
    }
  },

  isRunning(): boolean {
    return state.proc !== null && state.proc.exitCode === null && state.port !== null;
  },

  /**
   * Recycle the worker — fully shut it down so the next operation spawns a
   * fresh process. Use this between heavy long-running operations (atlas
   * rebuilds, etc.) to release accumulated state from BrowserContexts,
   * Chromium GPU/texture caches, retained DOM, etc.
   *
   * No-op if the worker isn't currently running.
   */
  async recycle(): Promise<void> {
    if (!state.proc) return;
    console.log('[browser] recycling worker — releasing accumulated state');
    await this.close();
  },

  // ============== Per-workspace context ==============

  async ensureContext(workspaceId: string): Promise<void> {
    await this.launch();
    // The worker creates the context lazily on first navigate/screenshot/etc.
    // For an explicit "warm up" we'd add a /context/ensure endpoint, but
    // implicit creation is fine for now.
    void workspaceId;
  },

  async closeContext(workspaceId: string, browserSessionId?: string): Promise<void> {
    if (!this.isRunning()) return;
    await workerFetch('POST', '/context/close', { workspaceId, browserSessionId });
  },

  async getStatus(workspaceId: string, browserSessionId?: string): Promise<{ running: boolean; url?: string; title?: string; browserSessionId?: string }> {
    if (!this.isRunning()) return { running: false };
    const session = browserSessionId ? `&browserSessionId=${encodeURIComponent(browserSessionId)}` : '';
    return await workerFetch('GET', `/status?workspaceId=${encodeURIComponent(workspaceId)}${session}`);
  },

  /** Called by the agent service when a `file_changed` event fires. */
  async notifyFileChanged(workspaceId: string): Promise<void> {
    if (!this.isRunning()) return;
    await workerFetch('POST', '/file-changed', { workspaceId }).catch(() => { /* best-effort */ });
  },

  // ============== Navigation ==============

  async navigate(workspaceId: string, url: string, browserSessionId?: string): Promise<{ url: string; title: string }> {
    await this.launch();
    const r = await workerFetch('POST', '/navigate', { workspaceId, browserSessionId, url });
    return { url: r.url, title: r.title };
  },

  // ============== Screenshots ==============

  async screenshot(workspaceId: string, opts: { selector?: string; fullPage?: boolean; name?: string; outDir?: string; browserSessionId?: string; runId?: string } = {}): Promise<string> {
    await this.launch();
    const r = await workerFetch('POST', '/screenshot', { workspaceId, ...opts });
    return r.path;
  },

  // ============== Interaction ==============

  async click(workspaceId: string, selector: string, browserSessionId?: string): Promise<void> {
    await this.launch();
    await workerFetch('POST', '/click', { workspaceId, browserSessionId, selector });
  },

  async type(workspaceId: string, selector: string, text: string, browserSessionId?: string): Promise<void> {
    await this.launch();
    await workerFetch('POST', '/type', { workspaceId, browserSessionId, selector, text });
  },

  // ============== Stability ==============

  async waitForReady(workspaceId: string, browserSessionId?: string): Promise<{ duration: number }> {
    await this.launch();
    const r = await workerFetch('POST', '/wait-for-ready', { workspaceId, browserSessionId });
    return { duration: r.duration };
  },

  // ============== Console ==============

  async getConsoleOutput(workspaceId: string, browserSessionId?: string): Promise<ConsoleEntry[]> {
    if (!this.isRunning()) return [];
    const session = browserSessionId ? `&browserSessionId=${encodeURIComponent(browserSessionId)}` : '';
    const r = await workerFetch('GET', `/console?workspaceId=${encodeURIComponent(workspaceId)}${session}`);
    return r.entries || [];
  },

  async clearConsole(workspaceId: string, browserSessionId?: string): Promise<void> {
    if (!this.isRunning()) return;
    await workerFetch('POST', '/console/clear', { workspaceId, browserSessionId });
  },

  // ============== Network evidence ==============

  async getNetworkOutput(workspaceId: string, browserSessionId?: string): Promise<NetworkEntry[]> {
    if (!this.isRunning()) return [];
    const session = browserSessionId ? `&browserSessionId=${encodeURIComponent(browserSessionId)}` : '';
    const r = await workerFetch('GET', `/network?workspaceId=${encodeURIComponent(workspaceId)}${session}`);
    return r.entries || [];
  },

  async clearNetwork(workspaceId: string, browserSessionId?: string): Promise<void> {
    if (!this.isRunning()) return;
    await workerFetch('POST', '/network/clear', { workspaceId, browserSessionId });
  },

  async setViewport(workspaceId: string, width: number, height: number, browserSessionId?: string): Promise<void> {
    await this.launch();
    await workerFetch('POST', '/viewport', { workspaceId, browserSessionId, width, height });
  },

  // ============== Arbitrary script evaluation (powerful — Atlas use) ==============

  async evaluate(workspaceId: string, script: string, browserSessionId?: string): Promise<any> {
    await this.launch();
    const r = await workerFetch('POST', '/evaluate', { workspaceId, browserSessionId, script }, 20_000);
    return r.result;
  },
};
