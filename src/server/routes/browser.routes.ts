// REST endpoints under /api/browser/* — used by the QA agent (via curl)
// to drive Playwright. Each handler is a thin wrapper around browserService.

import { jsonResponse } from '../utils';
import { browserService } from '../services/browser.service';
import { broadcast } from '../broadcast';
import * as path from 'node:path';
import * as os from 'node:os';

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
  try {
    const path = await browserService.screenshot(workspaceId, {
      selector: typeof body.selector === 'string' ? body.selector : undefined,
      fullPage: body.fullPage === true,
    });
    // Stream to clients so the QA panel can show screenshots live as they're taken.
    broadcast({ type: 'qa_screenshot_taken', workspaceId, path, timestamp: Date.now() });
    return jsonResponse({ ok: true, path });
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
 * Serve a QA screenshot from disk. Path validation: must be inside
 * os.tmpdir()/agent-forge-qa/, must end in .png. Used by the frontend
 * to render screenshots inline in the QA panel without base64-encoding
 * megabytes of image data over the WS.
 */
export async function handleQaScreenshot(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const requested = url.searchParams.get('path');
  if (!requested) return err('path required');

  const allowedRoot = path.resolve(path.join(os.tmpdir(), 'agent-forge-qa'));
  const resolved = path.resolve(requested);
  if (!resolved.startsWith(allowedRoot + path.sep) && resolved !== allowedRoot) {
    return err('path outside allowed root', 403);
  }
  if (!resolved.toLowerCase().endsWith('.png')) {
    return err('only .png files allowed', 400);
  }

  const file = Bun.file(resolved);
  if (!(await file.exists())) return err('not found', 404);
  return new Response(file, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
  });
}
