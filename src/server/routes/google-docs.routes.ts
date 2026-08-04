import { googleDocsService } from '../services/google-docs.service';
import { jsonResponse } from '../utils';

const MAX_WRITE_TEXT = 100_000;

async function readJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { throw new Error('Request body must be valid JSON'); }
}

function textField(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new Error(`${name} is required`);
  if (value.length > MAX_WRITE_TEXT) throw new Error(`${name} exceeds ${MAX_WRITE_TEXT.toLocaleString()} characters`);
  return value;
}

function optionalTextField(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function errorResponse(error: any): Response {
  const message = String(error?.message || error || 'Google Docs request failed').slice(0, 500);
  const status = /not configured|not found|is required|must be|docs\.google\.com|valid JSON|outside|exceeds/i.test(message) ? 400 : 502;
  return jsonResponse({ error: message }, status);
}

export async function handleGoogleDocsIntegration(req: Request): Promise<Response> {
  try {
    if (req.method === 'GET') return jsonResponse(await googleDocsService.getStatus());
    const body = await readJson(req);
    await googleDocsService.configure(textField(body.documentUrl, 'documentUrl'), typeof body.credentialPath === 'string' ? body.credentialPath : undefined);
    return jsonResponse(await googleDocsService.getStatus());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleGoogleDocsDocument(): Promise<Response> {
  try { return jsonResponse(await googleDocsService.getDocument()); } catch (error) { return errorResponse(error); }
}

export async function handleGoogleDocsAppend(req: Request, dedupe: boolean): Promise<Response> {
  try {
    const body = await readJson(req);
    const value = textField(body.text, 'text');
    const tabId = optionalTextField(body.tabId, 'tabId');
    return jsonResponse(dedupe
      ? await googleDocsService.appendIfAbsent(value, typeof body.dedupeText === 'string' ? body.dedupeText : undefined, tabId)
      : await googleDocsService.append(value, typeof body.revisionId === 'string' ? body.revisionId : undefined, tabId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleGoogleDocsReplace(req: Request): Promise<Response> {
  try {
    const body = await readJson(req);
    return jsonResponse(await googleDocsService.replace(
      textField(body.search, 'search'),
      textField(body.replacement, 'replacement', true),
      typeof body.revisionId === 'string' ? body.revisionId : undefined,
      body.matchCase !== false,
      optionalTextField(body.tabId, 'tabId'),
    ));
  } catch (error) {
    return errorResponse(error);
  }
}
