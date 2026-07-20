import { basename } from 'node:path';
import { agentService } from '../services/agent.service';
import {
  ChatImageError,
  resolveStoredChatImagePath,
  storeChatImageRequest,
} from '../services/chat-image.service';
import { jsonResponse } from '../utils';

function errorResponse(error: unknown): Response {
  const status = error instanceof ChatImageError ? error.status : 500;
  const message = error instanceof Error ? error.message : 'Unable to process chat image';
  return jsonResponse({ error: message }, status);
}

export async function handleChatImageUpload(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const agentId = url.searchParams.get('agentId')?.trim();
    const name = url.searchParams.get('name') || 'image';
    if (!agentId) throw new ChatImageError('agentId is required');
    if (!agentService.getAgent(agentId)) throw new ChatImageError('Agent not found', 404);
    return jsonResponse(await storeChatImageRequest(req, agentId, name));
  } catch (error) {
    return errorResponse(error);
  }
}

export function handleChatImage(req: Request): Response {
  try {
    const requested = new URL(req.url).searchParams.get('path');
    if (!requested) throw new ChatImageError('path is required');
    const image = resolveStoredChatImagePath(requested);
    const filename = basename(image.path).replace(/["\r\n]/g, '_');
    return new Response(Bun.file(image.path), {
      headers: {
        'Content-Type': image.mimeType,
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
