// REST endpoints under /api/browser/* — used by the QA agent (via curl)
// to drive Playwright. Each handler is a thin wrapper around browserService.

import { jsonResponse } from '../utils';
import { browserService } from '../services/browser.service';
import { broadcast } from '../broadcast';
import * as path from 'node:path';
import * as os from 'node:os';

// ============== Stuck-pattern detection ==============
// Track recent browser endpoint calls per workspace. If the agent makes the same
// call (endpoint + args) 5 times in a row, broadcast an advisory warning.
// Once unstuck (different call), the streak resets.
//
// HMR-safe state via globalThis so it survives `bun --hot` reloads.
interface CallRecord { endpoint: string; argsHash: string; timestamp: number }
const callHistoryByWs: Map<string, CallRecord[]> =
  ((globalThis as any).__browserCallHistory ??= new Map<string, CallRecord[]>());
const lastWarnedFor: Map<string, string> =
  ((globalThis as any).__browserLastWarnedFor ??= new Map<string, string>());

const STUCK_REPEAT_THRESHOLD = 5;
const HISTORY_LIMIT = 20;

function trackBrowserCall(workspaceId: string, endpoint: string, args: any): void {
  const argsHash = (() => {
    try { return JSON.stringify(args ?? {}).slice(0, 200); }
    catch { return '<unserializable>'; }
  })();
  const record: CallRecord = { endpoint, argsHash, timestamp: Date.now() };
  const history = callHistoryByWs.get(workspaceId) ?? [];
  history.push(record);
  while (history.length > HISTORY_LIMIT) history.shift();
  callHistoryByWs.set(workspaceId, history);

  if (history.length < STUCK_REPEAT_THRESHOLD) return;
  const recent = history.slice(-STUCK_REPEAT_THRESHOLD);
  const allSame = recent.every(r => r.endpoint === record.endpoint && r.argsHash === record.argsHash);
  const streakKey = `${endpoint}|${argsHash}`;
  if (allSame) {
    if (lastWarnedFor.get(workspaceId) !== streakKey) {
      lastWarnedFor.set(workspaceId, streakKey);
      console.warn(`[qa-stuck] ws=${workspaceId} endpoint=${endpoint} repeated ${STUCK_REPEAT_THRESHOLD}x args=${argsHash}`);
      broadcast({
        type: 'qa_stuck_warning',
        workspaceId,
        endpoint,
        repeatCount: STUCK_REPEAT_THRESHOLD,
        argsPreview: argsHash,
      });
    }
  } else {
    lastWarnedFor.delete(workspaceId);
  }
}
// ====================================================

function err(msg: string, status = 400): Response {
  return jsonResponse({ ok: false, error: msg }, status);
}

async function readJson(req: Request): Promise<any> {
  try { return await req.json(); }
  catch { return {}; }
}

function requireString(obj: any, key: string): string | null {
  const v = obj?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export async function handleBrowserNavigate(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workspaceId = requireString(body, 'workspaceId');
  const url = requireString(body, 'url');
  if (!workspaceId) return err('workspaceId required');
  if (!url) return err('url required');
  trackBrowserCall(workspaceId, 'navigate', { url });
  try {
    const r = await browserService.navigate(workspaceId, url);
    return jsonResponse({ ok: true, ...r });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserScreenshot(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workspaceId = requireString(body, 'workspaceId');
  if (!workspaceId) return err('workspaceId required');
  trackBrowserCall(workspaceId, 'screenshot', { selector: body.selector, fullPage: body.fullPage === true, name: body.name, outDir: body.outDir });

  // Validate outDir (atlas-mode direct write): must resolve under
  // <workspace.atlasProjectCwd>/docs/ui-atlas/. Anything else is rejected so
  // the agent can't write screenshots into arbitrary project locations.
  let outDir: string | undefined;
  if (typeof body.outDir === 'string' && body.outDir.trim()) {
    const { workspaceService } = await import('../services/workspace.service');
    const ws = workspaceService.get(workspaceId);
    if (!ws?.atlasProjectCwd) return err('outDir requires workspace.atlasProjectCwd', 400);
    const atlasRoot = path.resolve(path.join(ws.atlasProjectCwd, 'docs', 'ui-atlas'));
    const requested = path.resolve(body.outDir.trim());
    if (!requested.startsWith(atlasRoot + path.sep) && requested !== atlasRoot) {
      return err('outDir must be inside <workspace>/docs/ui-atlas/', 403);
    }
    outDir = requested;
  }

  try {
    const screenshotPath = await browserService.screenshot(workspaceId, {
      selector: typeof body.selector === 'string' ? body.selector : undefined,
      fullPage: body.fullPage === true,
      name: typeof body.name === 'string' ? body.name : undefined,
      outDir,
    });
    // Stream to clients so the QA panel can show screenshots live as they're taken.
    broadcast({ type: 'qa_screenshot_taken', workspaceId, path: screenshotPath, timestamp: Date.now() });
    return jsonResponse({ ok: true, path: screenshotPath });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserClick(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workspaceId = requireString(body, 'workspaceId');
  const selector = requireString(body, 'selector');
  if (!workspaceId) return err('workspaceId required');
  if (!selector) return err('selector required');
  trackBrowserCall(workspaceId, 'click', { selector });
  try {
    await browserService.click(workspaceId, selector);
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserType(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workspaceId = requireString(body, 'workspaceId');
  const selector = requireString(body, 'selector');
  const text = typeof body.text === 'string' ? body.text : null;
  if (!workspaceId) return err('workspaceId required');
  if (!selector) return err('selector required');
  if (text === null) return err('text required');
  trackBrowserCall(workspaceId, 'type', { selector, text });
  try {
    await browserService.type(workspaceId, selector, text);
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserWaitForReady(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workspaceId = requireString(body, 'workspaceId');
  if (!workspaceId) return err('workspaceId required');
  trackBrowserCall(workspaceId, 'wait-for-ready', {});
  try {
    const r = await browserService.waitForReady(workspaceId);
    return jsonResponse({ ok: true, ...r });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserConsoleGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required');
  try {
    const entries = await browserService.getConsoleOutput(workspaceId);
    return jsonResponse({ ok: true, entries });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserConsoleClear(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workspaceId = requireString(body, 'workspaceId');
  if (!workspaceId) return err('workspaceId required');
  try {
    await browserService.clearConsole(workspaceId);
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserStatus(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required');
  try {
    const status = await browserService.getStatus(workspaceId);
    return jsonResponse(status);
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

/**
 * Run an arbitrary JS expression in the page context. The Atlas Agent's primary
 * escape hatch for canvas interactions and state mutation when click selectors
 * don't work. Returns the JSON-serializable result of the expression.
 *
 * NOTE: this is powerful — arbitrary code in the page. We expose it because the
 * Atlas Agent needs it to be exhaustive. If you ever ship this to a multi-tenant
 * surface, gate it.
 */
export async function handleBrowserEvaluate(req: Request): Promise<Response> {
  const body = await readJson(req);
  const workspaceId = requireString(body, 'workspaceId');
  const script = requireString(body, 'script');
  if (!workspaceId) return err('workspaceId required');
  if (!script) return err('script (non-empty string) required');
  trackBrowserCall(workspaceId, 'evaluate', { script: script.slice(0, 120) });
  try {
    const result = await browserService.evaluate(workspaceId, script);
    return jsonResponse({ ok: true, result });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

/**
 * Serve a UI Atlas file (atlas.md or screenshot) for the atlas viewer panel.
 * Sandboxed: must resolve under <workspace.atlasProjectCwd>/docs/ui-atlas/.
 *
 * Query params:
 *   - workspaceId: which workspace's atlas to read from
 *   - relPath: relative path inside docs/ui-atlas/ (e.g. "atlas.md" or "shots/surface-galaxy.png")
 */
export async function handleAtlasFile(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  const relPath = url.searchParams.get('relPath');
  if (!workspaceId) return err('workspaceId required');
  if (!relPath) return err('relPath required');

  // Inline-import to avoid circular deps in the route module.
  const { workspaceService } = await import('../services/workspace.service');
  const ws = workspaceService.get(workspaceId);
  if (!ws) return err('Workspace not found', 404);
  if (!ws.atlasProjectCwd) return err('Workspace has no atlas project cwd', 404);

  const atlasRoot = path.resolve(path.join(ws.atlasProjectCwd, 'docs', 'ui-atlas'));
  const requested = path.resolve(path.join(atlasRoot, relPath));
  if (!requested.startsWith(atlasRoot + path.sep) && requested !== atlasRoot) {
    return err('relPath outside atlas root', 403);
  }

  const file = Bun.file(requested);
  if (!(await file.exists())) return err('not found', 404);
  // Pick a reasonable content-type by extension.
  const ext = path.extname(requested).toLowerCase();
  const contentType = ext === '.md' ? 'text/markdown; charset=utf-8'
    : ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.json' ? 'application/json'
    : 'application/octet-stream';
  return new Response(file, {
    headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
  });
}

/**
 * Serve a QA screenshot from disk. Allowed roots:
 *   - os.tmpdir()/agent-forge-qa/  (QA Tester transient screenshots)
 *   - <ws.atlasProjectCwd>/docs/ui-atlas/  (Atlas Agent direct-write shots)
 * Must end in .png. Used by the frontend to render screenshots inline
 * without base64-encoding megabytes of image data over the WS.
 */
export async function handleQaScreenshot(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requested = url.searchParams.get('path');
  if (!requested) return err('path required');

  const resolved = path.resolve(requested);
  if (!resolved.toLowerCase().endsWith('.png')) {
    return err('only .png files allowed', 400);
  }

  const tmpRoot = path.resolve(path.join(os.tmpdir(), 'agent-forge-qa'));
  const inTmp = resolved.startsWith(tmpRoot + path.sep) || resolved === tmpRoot;

  let inAtlas = false;
  if (!inTmp) {
    const { workspaceService } = await import('../services/workspace.service');
    for (const ws of workspaceService.values()) {
      if (!ws.atlasProjectCwd) continue;
      const atlasRoot = path.resolve(path.join(ws.atlasProjectCwd, 'docs', 'ui-atlas'));
      if (resolved.startsWith(atlasRoot + path.sep)) { inAtlas = true; break; }
    }
  }
  if (!inTmp && !inAtlas) return err('path outside allowed root', 403);

  const file = Bun.file(resolved);
  if (!(await file.exists())) return err('not found', 404);
  return new Response(file, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
  });
}
