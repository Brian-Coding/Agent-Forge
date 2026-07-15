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
}

// HMR-safe state — survives `bun --hot` reloads
const state: WorkerState = (globalThis as any).__browserWorkerState ??= {
  proc: null,
  port: null,
  ready: null,
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const init: RequestInit = { method, signal: controller.signal };
  if (method === 'POST') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  try {
    const res = await fetch(workerUrl(pathname), init);
    const json = await res.json().catch(() => ({}));
    if (!res.ok || (json && typeof json === 'object' && 'ok' in json && (json as any).ok === false)) {
      const msg = (json as any)?.error || `worker returned HTTP ${res.status}`;
      throw new Error(msg);
    }
    return json;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Browser worker ${method} ${pathname.split('?')[0]} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function spawnWorker(): Promise<void> {
  if (state.ready) return state.ready;

  state.ready = new Promise<void>((resolve, reject) => {
    const proc = spawn('node', [WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, AGENT_FORGE_ARTIFACT_ROOT: getArtifactRoot() },
    });
    state.proc = proc;

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        state.proc = null;
        state.ready = null;
        reject(new Error(`Browser worker did not become ready within ${WORKER_READY_TIMEOUT_MS}ms`));
      }
    }, WORKER_READY_TIMEOUT_MS);

    let stdoutBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      // Look for READY:<port>\n
      const m = stdoutBuf.match(/READY:(\d+)/);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        state.port = parseInt(m[1]!, 10);
        if (proc.pid) persistenceService.trackPid(proc.pid);
        resolve();
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      // Surface worker errors to the server log.
      const text = chunk.toString('utf8');
      if (text.trim()) console.error('[browser-worker]', text.trimEnd());
    });

    proc.on('exit', (code, signal) => {
      if (proc.pid) persistenceService.untrackPid(proc.pid);
      const wasRunning = state.proc === proc;
      state.proc = null;
      state.port = null;
      state.ready = null;
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
        state.proc = null;
        state.port = null;
        state.ready = null;
        reject(err);
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
    const proc = state.proc;
    if (!proc) return;
    // Ask the worker to shut down cleanly; if it doesn't exit in 3s, kill it.
    try {
      await workerFetch('POST', '/shutdown', undefined, 3000);
    } catch { /* ignore — worker may already be down */ }
    if (state.proc !== proc) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        resolve();
      }, 3000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
    });
  },

  isRunning(): boolean {
    return state.proc !== null && state.port !== null;
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
