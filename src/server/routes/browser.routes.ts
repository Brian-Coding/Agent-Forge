// REST endpoints under /api/browser/* — used by the QA agent (via curl)
// to drive Playwright. Each handler is a thin wrapper around browserService.

import { jsonResponse } from '../utils';
import { browserService } from '../services/browser.service';
import { broadcast } from '../broadcast';
import * as path from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { getArtifactRoot, getLegacyQaScreenshotRoot } from '../services/artifact-paths';
import { readJsonBody, RequestBodyError } from '../request-body';

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

function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function trackBrowserCall(
  workspaceId: string,
  endpoint: string,
  args: any,
  browserSessionId?: string,
): void {
  const historyKey = `${workspaceId}:${browserSessionId || 'default'}`;
  const argsHash = (() => {
    try { return JSON.stringify(args ?? {}).slice(0, 200); }
    catch { return '<unserializable>'; }
  })();
  const record: CallRecord = { endpoint, argsHash, timestamp: Date.now() };
  const history = callHistoryByWs.get(historyKey) ?? [];
  history.push(record);
  while (history.length > HISTORY_LIMIT) history.shift();
  callHistoryByWs.set(historyKey, history);

  if (history.length < STUCK_REPEAT_THRESHOLD) return;
  const recent = history.slice(-STUCK_REPEAT_THRESHOLD);
  const allSame = recent.every(r => r.endpoint === record.endpoint && r.argsHash === record.argsHash);
  const streakKey = `${endpoint}|${argsHash}`;
  if (allSame) {
    if (lastWarnedFor.get(historyKey) !== streakKey) {
      lastWarnedFor.set(historyKey, streakKey);
      console.warn(`[qa-stuck] ws=${workspaceId} session=${browserSessionId || 'default'} endpoint=${endpoint} repeated ${STUCK_REPEAT_THRESHOLD}x args=${argsHash}`);
      broadcast({
        type: 'qa_stuck_warning',
        workspaceId,
        endpoint,
        repeatCount: STUCK_REPEAT_THRESHOLD,
        argsPreview: argsHash,
      });
    }
  } else {
    lastWarnedFor.delete(historyKey);
  }
}
// ====================================================

function err(msg: string, status = 400): Response {
  return jsonResponse({ ok: false, error: msg }, status);
}

async function readJson(req: Request): Promise<{ body?: any; error?: Response }> {
  try {
    return { body: await readJsonBody(req, 1024 * 1024) };
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: err(error.message, error.status) };
    return { error: err('Unable to read request body', 500) };
  }
}

function requireString(obj: any, key: string): string | null {
  const v = obj?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

const BROWSER_SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;

function optionalBrowserSessionId(value: unknown): string | undefined | null {
  if (value == null || value === '') return undefined;
  return typeof value === 'string' && BROWSER_SESSION_ID_RE.test(value) ? value : null;
}

function optionalRunId(value: unknown): string | undefined | null {
  if (value == null || value === '') return undefined;
  return typeof value === 'string' && BROWSER_SESSION_ID_RE.test(value) ? value : null;
}

export async function handleBrowserNavigate(req: Request): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const url = requireString(body, 'url');
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  if (!workspaceId) return err('workspaceId required');
  if (!url) return err('url required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  trackBrowserCall(workspaceId, 'navigate', { url }, browserSessionId);
  try {
    const r = await browserService.navigate(workspaceId, url, browserSessionId);
    return jsonResponse({ ok: true, ...r });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserScreenshot(req: Request): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  const runId = optionalRunId(body.runId);
  if (!workspaceId) return err('workspaceId required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  if (runId === null) return err('invalid runId');
  trackBrowserCall(workspaceId, 'screenshot', { selector: body.selector, fullPage: body.fullPage === true, name: body.name, outDir: body.outDir }, browserSessionId);

  // Validate outDir (Atlas direct write): it may target the published Atlas
  // for legacy callers or this workspace's exact active candidate. Resolve
  // real paths as well as lexical paths so a junction/symlink cannot escape.
  let outDir: string | undefined;
  if (typeof body.outDir === 'string' && body.outDir.trim()) {
    const { workspaceService } = await import('../services/workspace.service');
    const ws = workspaceService.get(workspaceId);
    if (!ws?.atlasProjectCwd) return err('outDir requires workspace.atlasProjectCwd', 400);
    const requested = path.resolve(body.outDir.trim());
    const canonicalRoot = path.resolve(path.join(ws.atlasProjectCwd, 'docs', 'ui-atlas'));
    const candidateIsActive = !!ws.atlasRun && ['running', 'validating', 'paused', 'failed'].includes(ws.atlasRun.status);
    const allowedRoots = candidateIsActive && ws.atlasRun?.candidateRelPath
      ? [path.resolve(path.join(ws.atlasProjectCwd, ws.atlasRun.candidateRelPath))]
      : [canonicalRoot];
    const lexicalMatch = allowedRoots.some(root => isPathInside(root, requested));
    if (!lexicalMatch) return err('outDir must be inside the published Atlas or active Atlas candidate', 403);

    try {
      const { realpath } = await import('node:fs/promises');
      const realRequested = await realpath(requested);
      let realMatch = false;
      for (const root of allowedRoots) {
        if (!existsSync(root)) continue;
        const realRoot = await realpath(root);
        if (isPathInside(realRoot, realRequested)) {
          realMatch = true;
          break;
        }
      }
      if (!realMatch) return err('outDir resolves outside its allowed Atlas root', 403);
    } catch {
      return err('outDir must already exist inside the active Atlas candidate', 400);
    }
    outDir = requested;
  }

  try {
    const screenshotPath = await browserService.screenshot(workspaceId, {
      selector: typeof body.selector === 'string' ? body.selector : undefined,
      fullPage: body.fullPage === true,
      name: typeof body.name === 'string' ? body.name : undefined,
      outDir,
      browserSessionId,
      runId,
    });
    // Stream to clients so the QA panel can show screenshots live as they're taken.
    broadcast({ type: 'qa_screenshot_taken', workspaceId, path: screenshotPath, timestamp: Date.now(), browserSessionId });
    return jsonResponse({ ok: true, path: screenshotPath });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserClick(req: Request): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const selector = requireString(body, 'selector');
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  if (!workspaceId) return err('workspaceId required');
  if (!selector) return err('selector required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  trackBrowserCall(workspaceId, 'click', { selector }, browserSessionId);
  try {
    await browserService.click(workspaceId, selector, browserSessionId);
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserType(req: Request): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const selector = requireString(body, 'selector');
  const text = typeof body.text === 'string' ? body.text : null;
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  if (!workspaceId) return err('workspaceId required');
  if (!selector) return err('selector required');
  if (text === null) return err('text required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  trackBrowserCall(workspaceId, 'type', { selector, textLength: text.length }, browserSessionId);
  try {
    await browserService.type(workspaceId, selector, text, browserSessionId);
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserWaitForReady(req: Request): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  if (!workspaceId) return err('workspaceId required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  trackBrowserCall(workspaceId, 'wait-for-ready', {}, browserSessionId);
  try {
    const r = await browserService.waitForReady(workspaceId, browserSessionId);
    return jsonResponse({ ok: true, ...r });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserConsoleGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  const browserSessionId = optionalBrowserSessionId(url.searchParams.get('browserSessionId'));
  if (!workspaceId) return err('workspaceId required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  try {
    const entries = await browserService.getConsoleOutput(workspaceId, browserSessionId);
    return jsonResponse({ ok: true, entries });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserConsoleClear(req: Request): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  if (!workspaceId) return err('workspaceId required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  try {
    await browserService.clearConsole(workspaceId, browserSessionId);
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserStatus(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  const browserSessionId = optionalBrowserSessionId(url.searchParams.get('browserSessionId'));
  if (!workspaceId) return err('workspaceId required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  try {
    const status = await browserService.getStatus(workspaceId, browserSessionId);
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
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const script = requireString(body, 'script');
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  if (!workspaceId) return err('workspaceId required');
  if (!script) return err('script (non-empty string) required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  trackBrowserCall(workspaceId, 'evaluate', { scriptLength: script.length }, browserSessionId);
  try {
    const result = await browserService.evaluate(workspaceId, script, browserSessionId);
    return jsonResponse({ ok: true, result });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserNetworkGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get('workspaceId');
  const browserSessionId = optionalBrowserSessionId(url.searchParams.get('browserSessionId'));
  if (!workspaceId) return err('workspaceId required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  try {
    const entries = await browserService.getNetworkOutput(workspaceId, browserSessionId);
    return jsonResponse({ ok: true, entries });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserNetworkClear(req: Request): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  if (!workspaceId) return err('workspaceId required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  try {
    await browserService.clearNetwork(workspaceId, browserSessionId);
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserViewport(req: Request): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  const width = Number(body.width);
  const height = Number(body.height);
  if (!workspaceId) return err('workspaceId required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  if (!Number.isInteger(width) || width < 320 || width > 7680) return err('width must be an integer from 320 to 7680');
  if (!Number.isInteger(height) || height < 240 || height > 4320) return err('height must be an integer from 240 to 4320');
  try {
    await browserService.setViewport(workspaceId, width, height, browserSessionId);
    return jsonResponse({ ok: true, width, height });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function handleBrowserContextClose(req: Request): Promise<Response> {
  const parsed = await readJson(req);
  if (parsed.error) return parsed.error;
  const body = parsed.body;
  const workspaceId = requireString(body, 'workspaceId');
  const browserSessionId = optionalBrowserSessionId(body.browserSessionId);
  if (!workspaceId) return err('workspaceId required');
  if (browserSessionId === null) return err('invalid browserSessionId');
  try {
    await browserService.closeContext(workspaceId, browserSessionId);
    return jsonResponse({ ok: true });
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
  if (!isPathInside(atlasRoot, requested)) {
    return err('relPath outside atlas root', 403);
  }

  const file = Bun.file(requested);
  if (!(await file.exists())) return err('not found', 404);
  try {
    if (!isPathInside(realpathSync(atlasRoot), realpathSync(requested))) {
      return err('relPath resolves outside atlas root', 403);
    }
  } catch {
    return err('not found', 404);
  }
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
 *   - Agent Forge's stable local artifact root (current QA runs)
 *   - os.tmpdir()/agent-forge-qa/  (legacy QA screenshots)
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

  const artifactRoot = getArtifactRoot();
  const legacyTmpRoot = getLegacyQaScreenshotRoot();
  const inArtifacts = isPathInside(artifactRoot, resolved);
  const inLegacyTmp = isPathInside(legacyTmpRoot, resolved);

  let inAtlas = false;
  let matchedRoot: string | null = inArtifacts ? artifactRoot : inLegacyTmp ? legacyTmpRoot : null;
  if (!inArtifacts && !inLegacyTmp) {
    const { workspaceService } = await import('../services/workspace.service');
    for (const ws of workspaceService.values()) {
      if (!ws.atlasProjectCwd) continue;
      const atlasRoot = path.resolve(path.join(ws.atlasProjectCwd, 'docs', 'ui-atlas'));
      if (isPathInside(atlasRoot, resolved)) { inAtlas = true; matchedRoot = atlasRoot; break; }
    }
  }
  if (!inArtifacts && !inLegacyTmp && !inAtlas) return err('path outside allowed root', 403);

  const file = Bun.file(resolved);
  if (!(await file.exists())) return err('not found', 404);
  try {
    if (!matchedRoot || !existsSync(matchedRoot) || !isPathInside(realpathSync(matchedRoot), realpathSync(resolved))) {
      return err('path resolves outside allowed root', 403);
    }
  } catch {
    return err('not found', 404);
  }
  return new Response(file, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
  });
}
