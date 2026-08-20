import { AtlasAnswerValidationError } from '../services/atlas-query-result';
import { AtlasQueryBusyError, atlasQueryService } from '../services/atlas-query.service';
import { jsonResponse } from '../utils';
import { readJsonBody, RequestBodyError } from '../request-body';

const MAX_BODY_BYTES = 8_000;

export async function handleAskAtlas(req: Request): Promise<Response> {
  try {
    const body: any = await readJsonBody(req, MAX_BODY_BYTES);
    if (typeof body?.workspaceId !== 'string' || !body.workspaceId.trim()) {
      return jsonResponse({ error: 'workspaceId is required' }, 400);
    }
    if (typeof body?.question !== 'string' || !body.question.trim()) {
      return jsonResponse({ error: 'question is required' }, 400);
    }
    const answer = await atlasQueryService.ask(body.workspaceId.trim(), body.question);
    return jsonResponse(answer);
  } catch (error: any) {
    if (error instanceof RequestBodyError) return jsonResponse({ error: error.message }, error.status);
    if (error instanceof AtlasQueryBusyError) return jsonResponse({ error: error.message }, 409);
    if (error instanceof AtlasAnswerValidationError) {
      return jsonResponse({ error: 'Atlas Analyst returned an ungrounded answer', validationErrors: error.errors }, 422);
    }
    return jsonResponse({ error: error?.message || 'Ask Atlas failed' }, 500);
  }
}
