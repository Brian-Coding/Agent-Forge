import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildArtifactInventory,
  classifyArtifactRelativePath,
  collectArtifactReferences,
  createdArtifactLogPath,
  recordCreatedArtifact,
} from './artifact-inventory.service';

test('taxonomy classifies known artifact locations', () => {
  expect(classifyArtifactRelativePath('chat-images/agent/1.png')).toBe('chat-upload-original');
  expect(classifyArtifactRelativePath('mystery.bin')).toBe('unknown');
});

test('inventory is read-only and proposes quarantine without moving files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-artifact-inventory-'));
  const kept = join(root, 'chat-images', 'agent-1', 'kept.png');
  const orphan = join(root, 'chat-images', 'agent-1', 'orphan.png');
  const leaked = join(root, 'notes.txt');
  await mkdir(join(root, 'chat-images', 'agent-1'), { recursive: true });
  await writeFile(kept, 'kept-bytes');
  await writeFile(orphan, 'orphan-bytes');
  await writeFile(leaked, 'unknown');
  const before = await readFile(orphan, 'utf8');

  const report = await buildArtifactInventory({
    artifactRoot: root,
    persisted: {
      messages: [{
        id: 'm1',
        agentId: 'agent-1',
        role: 'user',
        content: 'hi',
        timestamp: 1,
        imageAttachments: [{ path: kept, name: 'kept.png', mimeType: 'image/png', size: 10 }],
      }],
      workspaces: [],
    } as any,
    references: [join(root, '..', 'outside.png')],
  });

  expect(await readFile(orphan, 'utf8')).toBe(before);
  expect(report.totals.files).toBe(3);
  expect(report.referenced).toBe(1);
  expect(report.unreferenced).toBe(2);
  expect(report.unknown).toBe(1);
  expect(report.outsideRoot).toBe(1);
  expect(report.proposedQuarantine.map(item => item.relativePath).sort()).toEqual([
    'chat-images/agent-1/orphan.png',
    'notes.txt',
  ]);
  expect(report.inventoryId).toHaveLength(24);
  await rm(root, { recursive: true, force: true });
});

test('created artifacts are appended to a manifest and skipped as inventory noise', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-artifact-created-'));
  const file = join(root, 'chat-images', 'agent-2', 'new.png');
  await mkdir(join(root, 'chat-images', 'agent-2'), { recursive: true });
  await writeFile(file, 'png');
  const record = await recordCreatedArtifact({
    type: 'chat-upload-original',
    absolutePath: file,
    byteSize: 3,
    artifactRoot: root,
    ownerRefs: [{ kind: 'message', id: 'agent-2' }],
  });
  expect(record?.relativePath).toBe('chat-images/agent-2/new.png');
  const log = await readFile(createdArtifactLogPath(root), 'utf8');
  expect(log).toContain('"chat-upload-original"');
  const report = await buildArtifactInventory({ artifactRoot: root, references: [file] });
  expect(report.totals.files).toBe(1);
  expect(report.referenced).toBe(1);
  await rm(root, { recursive: true, force: true });
});

test('reference collection reads message image attachments', () => {
  const refs = collectArtifactReferences({
    messages: [{
      id: 'm1', agentId: 'a', role: 'user', content: '', timestamp: 1,
      imageAttachments: [{ path: 'C:\\img\\one.png', name: 'one.png', mimeType: 'image/png', size: 1 }],
    }],
  } as any, ['extra/ref.png']);
  expect(refs).toEqual(['extra/ref.png', 'C:\\img\\one.png']);
});

test('leases keep files out of the quarantine proposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-artifact-lease-'));
  const leased = join(root, 'chat-images', 'pending.png');
  await mkdir(join(root, 'chat-images'), { recursive: true });
  await writeFile(leased, 'pending');
  const report = await buildArtifactInventory({
    artifactRoot: root,
    leases: [leased],
  });
  expect(report.activeLeases).toBe(1);
  expect(report.byLifecycle.leased).toBe(1);
  expect(report.proposedQuarantine).toEqual([]);
  await rm(root, { recursive: true, force: true });
});

test('symlinks are counted as malformed and are not followed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-artifact-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'af-artifact-outside-'));
  const secret = join(outside, 'secret.bin');
  await writeFile(secret, 'secret');
  try {
    await symlink(secret, join(root, 'escape.bin'));
  } catch {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    return;
  }
  const report = await buildArtifactInventory({ artifactRoot: root });
  expect(report.totals.files).toBe(0);
  expect(report.malformed).toBeGreaterThan(0);
  expect(await readFile(secret, 'utf8')).toBe('secret');
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
