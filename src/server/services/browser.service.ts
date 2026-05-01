// Browser service — Bun-side client to the Node Playwright worker.
//
// Why split: Playwright + Bun + Windows hangs on launch (Bun's
// child_process / IPC compat doesn't fully emulate Node's behavior, which
// Playwright depends on). The actual Playwright work runs in a Node
// subprocess; this service just spawns it and forwards calls over HTTP.

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { persistenceService } from './persistence.service';

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  timestamp: number;
}

const WORKER_SCRIPT = path.resolve(import.meta.dir, '../../../scripts/browser-worker.mjs');
const WORKER_READY_TIMEOUT_MS = 30_000;

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

async function workerFetch(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<any> {
  if (state.ready) await state.ready;
  if (state.port == null) throw new Error('Browser worker is not running');
  const init: RequestInit = { method };
  if (method === 'POST') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(workerUrl(pathname), init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json && typeof json === 'object' && 'ok' in json && (json as any).ok === false)) {
    const msg = (json as any)?.error || `worker returned HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function spawnWorker(): Promise<void> {
  if (state.ready) return state.ready;

  state.ready = new Promise<void>((resolve, reject) => {
    const proc = spawn('node', [WORKER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
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
      await workerFetch('POST', '/shutdown');
    } catch { /* ignore — worker may already be down */ }
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

  // ============== Per-workspace context ==============

  async ensureContext(workspaceId: string): Promise<void> {
    await this.launch();
    // The worker creates the context lazily on first navigate/screenshot/etc.
    // For an explicit "warm up" we'd add a /context/ensure endpoint, but
    // implicit creation is fine for now.
    void workspaceId;
  },

  async closeContext(workspaceId: string): Promise<void> {
    if (!this.isRunning()) return;
    await workerFetch('POST', '/context/close', { workspaceId });
  },

  async getStatus(workspaceId: string): Promise<{ running: boolean; url?: string; title?: string }> {
    if (!this.isRunning()) return { running: false };
    return await workerFetch('GET', `/status?workspaceId=${encodeURIComponent(workspaceId)}`);
  },

  /** Called by the agent service when a `file_changed` event fires. */
  async notifyFileChanged(workspaceId: string): Promise<void> {
    if (!this.isRunning()) return;
    await workerFetch('POST', '/file-changed', { workspaceId }).catch(() => { /* best-effort */ });
  },

  // ============== Navigation ==============

  async navigate(workspaceId: string, url: string): Promise<{ url: string; title: string }> {
    await this.launch();
    const r = await workerFetch('POST', '/navigate', { workspaceId, url });
    return { url: r.url, title: r.title };
  },

  // ============== Screenshots ==============

  async screenshot(workspaceId: string, opts: { selector?: string; fullPage?: boolean } = {}): Promise<string> {
    await this.launch();
    const r = await workerFetch('POST', '/screenshot', { workspaceId, ...opts });
    return r.path;
  },

  // ============== Interaction ==============

  async click(workspaceId: string, selector: string): Promise<void> {
    await this.launch();
    await workerFetch('POST', '/click', { workspaceId, selector });
  },

  async type(workspaceId: string, selector: string, text: string): Promise<void> {
    await this.launch();
    await workerFetch('POST', '/type', { workspaceId, selector, text });
  },

  // ============== Stability ==============

  async waitForReady(workspaceId: string): Promise<{ duration: number }> {
    await this.launch();
    const r = await workerFetch('POST', '/wait-for-ready', { workspaceId });
    return { duration: r.duration };
  },

  // ============== Console ==============

  async getConsoleOutput(workspaceId: string): Promise<ConsoleEntry[]> {
    if (!this.isRunning()) return [];
    const r = await workerFetch('GET', `/console?workspaceId=${encodeURIComponent(workspaceId)}`);
    return r.entries || [];
  },

  async clearConsole(workspaceId: string): Promise<void> {
    if (!this.isRunning()) return;
    await workerFetch('POST', '/console/clear', { workspaceId });
  },
};
