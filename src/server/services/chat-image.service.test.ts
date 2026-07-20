import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatImageAttachment } from '../../shared/protocol';
import {
  MAX_CHAT_IMAGE_TOTAL_BYTES,
  assertChatImageBatchLimits,
  buildExhaustiveImagePrompt,
  storeChatImageBytes,
  validateChatImageAttachments,
} from './chat-image.service';

const previousArtifactRoot = process.env.AGENT_FORGE_ARTIFACT_ROOT;
let artifactRoot = '';

beforeEach(() => {
  artifactRoot = mkdtempSync(join(tmpdir(), 'agent-forge-chat-images-test-'));
  process.env.AGENT_FORGE_ARTIFACT_ROOT = artifactRoot;
});

afterEach(() => {
  if (previousArtifactRoot === undefined) delete process.env.AGENT_FORGE_ARTIFACT_ROOT;
  else process.env.AGENT_FORGE_ARTIFACT_ROOT = previousArtifactRoot;
  if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
});

test('stores original image bytes outside chat JSON and validates the persisted attachment', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
  const stored = await storeChatImageBytes('agent-one', 'game-round.png', 'image/png', bytes);
  const [validated] = validateChatImageAttachments([stored]);

  expect(validated?.name).toBe('game-round.png');
  expect(validated?.mimeType).toBe('image/png');
  expect(validated?.size).toBe(bytes.byteLength);
  expect(validated?.path).toStartWith(artifactRoot);
});

test('accepts exactly 100 ordered images and rejects image 101', async () => {
  const stored = await storeChatImageBytes('agent-two', 'frame.png', 'image/png', new Uint8Array([1]));
  const hundred = Array.from({ length: 100 }, (_, index): ChatImageAttachment => ({
    ...stored,
    name: `frame-${String(index + 1).padStart(3, '0')}.png`,
  }));

  expect(validateChatImageAttachments(hundred).map(image => image.name)).toEqual(hundred.map(image => image.name));
  expect(() => validateChatImageAttachments([...hundred, stored])).toThrow('at most 100 images');
});

test('rejects paths outside managed chat-image storage and batches over 512 MiB', () => {
  const outside = join(tmpdir(), `agent-forge-outside-${Date.now()}.png`);
  writeFileSync(outside, 'not managed');
  try {
    expect(() => validateChatImageAttachments([{ path: outside, name: 'outside.png', mimeType: 'image/png', size: 11 }])).toThrow('outside chat image storage');
    expect(() => assertChatImageBatchLimits(100, MAX_CHAT_IMAGE_TOTAL_BYTES + 1)).toThrow('512 MiB');
  } finally {
    rmSync(outside, { force: true });
  }
});

test('image-analysis prompt requires exhaustive, auditable coverage', () => {
  const images: ChatImageAttachment[] = [
    { path: 'C:\\images\\round-01.png', name: 'round-01.png', mimeType: 'image/png', size: 10 },
    { path: 'C:\\images\\round-02.png', name: 'round-02.png', mimeType: 'image/png', size: 10 },
  ];
  const prompt = buildExhaustiveImagePrompt(images, 'Find every UI regression in this game round.');

  expect(prompt).toContain('All 2 images are attached natively');
  expect(prompt).toContain('Inspect EVERY attached image');
  expect(prompt).toContain('Inspected: N/N');
  expect(prompt).toContain('Image 1: round-01.png');
  expect(prompt).toContain('Image 2: round-02.png');
});
