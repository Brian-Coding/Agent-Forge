import { AtlasAnswerValidationError } from '../services/atlas-query-result';
import { AtlasQueryBusyError, atlasQueryService } from '../services/atlas-query.service';
import { jsonResponse } from '../utils';

const MAX_BODY_BYTES = 8_000;

export async function handleAskAtlas(req: Request): Promise<Response> {
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return jsonResponse({ error: 'Ask Atlas request is too large' }, 413);
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: 'Ask Atlas request must be valid JSON' }, 400);
    }
    if (typeof body?.workspaceId !== 'string' || !body.workspaceId.trim()) {
      return jsonResponse({ error: 'workspaceId is required' }, 400);
    }
    if (typeof body?.question !== 'string' || !body.question.trim()) {
      return jsonResponse({ error: 'question is required' }, 400);
    }
    const answer = await atlasQueryService.ask(body.workspaceId.trim(), body.question);
    return jsonResponse(answer);
  } catch (error: any) {
    if (error instanceof AtlasQueryBusyError) return jsonResponse({ error: error.message }, 409);
    if (error instanceof AtlasAnswerValidationError) {
      return jsonResponse({ error: 'Atlas Analyst returned an ungrounded answer', validationErrors: error.errors }, 422);
    }
    return jsonResponse({ error: error?.message || 'Ask Atlas failed' }, 500);
  }
}
