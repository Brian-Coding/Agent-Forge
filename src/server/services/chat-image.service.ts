import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ChatImageAttachment } from '../../shared/protocol';
import { recordCreatedArtifact } from './artifact-inventory.service';
import { getArtifactRoot, safeArtifactSegment } from './artifact-paths';

export const MAX_CHAT_IMAGES = 100;
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 512 * 1024 * 1024;

const MIME_TO_EXTENSION = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);
const EXTENSION_TO_MIME = new Map(Array.from(MIME_TO_EXTENSION, ([mime, extension]) => [extension, mime]));

export class ChatImageError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'ChatImageError';
  }
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeMimeType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function safeDisplayName(value: string, extension: string): string {
  const cleaned = basename(value || `image${extension}`)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 180)
    .trim();
  return cleaned || `image${extension}`;
}

export function getChatImageRoot(): string {
  return resolve(join(getArtifactRoot(), 'chat-images'));
}

export function assertChatImageBatchLimits(count: number, totalBytes: number): void {
  if (!Number.isInteger(count) || count < 1) throw new ChatImageError('At least one image is required');
  if (count > MAX_CHAT_IMAGES) throw new ChatImageError(`A single message can contain at most ${MAX_CHAT_IMAGES} images`, 413);
  if (!Number.isFinite(totalBytes) || totalBytes < 1) throw new ChatImageError('Image uploads cannot be empty');
  if (totalBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
    throw new ChatImageError('The image batch exceeds the 512 MiB model input limit', 413);
  }
}

export async function storeChatImageBytes(
  agentId: string,
  originalName: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<ChatImageAttachment> {
  const normalizedMime = normalizeMimeType(mimeType);
  const extension = MIME_TO_EXTENSION.get(normalizedMime);
  if (!extension) throw new ChatImageError('Supported image types are PNG, JPEG, WEBP, and non-animated GIF');
  assertChatImageBatchLimits(1, bytes.byteLength);

  const directory = resolve(join(getChatImageRoot(), safeArtifactSegment(agentId, 'agent')));
  mkdirSync(directory, { recursive: true });
  const path = resolve(join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}${extension}`));
  await Bun.write(path, bytes);
  await recordCreatedArtifact({
    type: 'chat-upload-original',
    absolutePath: path,
    byteSize: bytes.byteLength,
    artifactRoot: getArtifactRoot(),
    ownerRefs: [{ kind: 'message', id: agentId }],
  }).catch(() => null);

  return {
    path,
    name: safeDisplayName(originalName, extension),
    mimeType: normalizedMime,
    size: bytes.byteLength,
  };
}

export async function storeChatImageRequest(
  req: Request,
  agentId: string,
  originalName: string,
): Promise<ChatImageAttachment> {
  const announcedSize = Number(req.headers.get('content-length') || '0');
  if (announcedSize > MAX_CHAT_IMAGE_TOTAL_BYTES) {
    throw new ChatImageError('The image exceeds the 512 MiB model input limit', 413);
  }
  if (!req.body) throw new ChatImageError('Image uploads cannot be empty');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ChatImageError('The image exceeds the 512 MiB model input limit', 413);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return storeChatImageBytes(agentId, originalName, req.headers.get('content-type') || '', bytes);
}

export function resolveStoredChatImagePath(requestedPath: string): { path: string; mimeType: string; size: number } {
  if (!isAbsolute(requestedPath)) throw new ChatImageError('An absolute chat image path is required');
  const root = getChatImageRoot();
  const requested = resolve(requestedPath);
  if (!isPathInside(root, requested)) throw new ChatImageError('Image path is outside chat image storage', 403);

  const mimeType = EXTENSION_TO_MIME.get(extname(requested).toLowerCase());
  if (!mimeType) throw new ChatImageError('Unsupported chat image type');
  if (!existsSync(requested)) throw new ChatImageError('Chat image not found', 404);

  try {
    if (!isPathInside(realpathSync(root), realpathSync(requested))) {
      throw new ChatImageError('Image path resolves outside chat image storage', 403);
    }
  } catch (error) {
    if (error instanceof ChatImageError) throw error;
    throw new ChatImageError('Chat image not found', 404);
  }

  const stat = statSync(requested);
  if (!stat.isFile()) throw new ChatImageError('Chat image path is not a file');
  return { path: requested, mimeType, size: stat.size };
}

export function validateChatImageAttachments(images: readonly ChatImageAttachment[]): ChatImageAttachment[] {
  if (!Array.isArray(images)) throw new ChatImageError('Images must be an array');
  if (images.length > MAX_CHAT_IMAGES) {
    throw new ChatImageError(`A single message can contain at most ${MAX_CHAT_IMAGES} images`, 413);
  }

  let totalBytes = 0;
  const normalized = images.map((image, index) => {
    if (!image || typeof image.path !== 'string') throw new ChatImageError(`Image ${index + 1} has no path`);
    const stored = resolveStoredChatImagePath(image.path);
    totalBytes += stored.size;
    return {
      path: stored.path,
      name: safeDisplayName(typeof image.name === 'string' ? image.name : '', extname(stored.path)),
      mimeType: stored.mimeType,
      size: stored.size,
    };
  });
  assertChatImageBatchLimits(normalized.length, totalBytes);
  return normalized;
}

export function buildExhaustiveImagePrompt(images: readonly ChatImageAttachment[], prompt?: string): string {
  const requestedTask = prompt?.trim() || 'Analyze these screenshots and report every meaningful UI, UX, visual, or functional issue you can identify.';
  const manifest = images.map((image, index) => `Image ${index + 1}: ${image.name}\nPath: ${image.path}`).join('\n');
  return [
    requestedTask,
    '',
    `All ${images.length} images are attached natively to this turn at their original resolution.`,
    'Inspect EVERY attached image before answering. Do not sample, skip, or infer an image solely from its filename.',
    'Treat the images as an ordered sequence. Reference image numbers and filenames when reporting evidence.',
    'Spend as many tokens and tool calls as necessary. Completeness and accuracy take priority over speed or token economy.',
    'You may group related findings, but your final answer must include an Image coverage section stating "Inspected: N/N" and accounting for any unreadable image by exact number.',
    'If you cannot inspect every image, say so explicitly and identify exactly which images were not inspected; never imply complete coverage without it.',
    '',
    'Image manifest:',
    manifest,
  ].join('\n');
}
