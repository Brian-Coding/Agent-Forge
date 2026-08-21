import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LiveDocument } from '../../shared/protocol';
import { canonicalPlanPath, discoverPlanReferences, documentService, parsePlanLifecycle } from './document.service';
import { persistenceService } from './persistence.service';

test('document creation, plan updates, and lock release roll back on persistence failure', async () => {
  const map: Map<string, LiveDocument> = (globalThis as any).__documentsMap;
  const id = `atomic-doc-${randomUUID()}`;
  const filePath = `C:\\plans with spaces\\${id}.md`;
  const existing: LiveDocument = {
    id,
    title: id,
    content: 'durable content',
    lastEditedBy: 'Agent',
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    status: 'in_progress',
    lockedBy: 'agent-1',
    filePath,
    createdAt: 10,
    updatedAt: 20,
  };
  const originalSaveNow = persistenceService.saveNow;
  map.set(id, existing);
  persistenceService.saveNow = async () => { throw new Error('readonly filesystem'); };

  try {
    const idsBefore = new Set(map.keys());
    await expect(documentService.create('ghost', 'not durable')).rejects.toThrow('readonly filesystem');
    expect(new Set(map.keys())).toEqual(idsBefore);

    const beforeUpdate = structuredClone(existing);
    await expect(documentService.handlePlanWrite(
      'agent-1',
      'Changed Agent',
      true,
      'workspace-1',
      filePath,
      'uncommitted content',
    )).rejects.toThrow('readonly filesystem');
    expect(existing).toEqual(beforeUpdate);

    await expect(documentService.releaseLocksForAgent('agent-1')).rejects.toThrow('readonly filesystem');
    expect(existing).toEqual(beforeUpdate);

    await expect(documentService.handlePlanWrite(
      'other-agent',
      'Other Agent',
      true,
      'workspace-1',
      `C:\\plans with spaces\\new-${randomUUID()}.md`,
      'new but not durable',
    )).rejects.toThrow('readonly filesystem');
    expect(new Set(map.keys())).toEqual(idsBefore);
  } finally {
    persistenceService.saveNow = originalSaveNow;
    map.delete(id);
  }
});

test('plan lifecycle comes from Markdown and prompt context excludes historical plans', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-forge-plan-catalog-'));
  const plansDir = join(projectRoot, '.plans');
  await mkdir(plansDir);
  await writeFile(join(plansDir, 'README.md'), '# Plan Lifecycle Index\n\n> Lifecycle: Reference\n');
  await writeFile(join(plansDir, 'active.md'), '# Active Work\n\n> Lifecycle: Draft\n');
  await writeFile(join(plansDir, 'paused.md'), '# Paused Work\n\n> Lifecycle: Paused\n');
  await writeFile(join(plansDir, 'old.md'), '# Old Work\n\n> Lifecycle: Superseded\n');

  try {
    expect(parsePlanLifecycle('# Done\n\n> Lifecycle: Completed')).toBe('completed');
    expect(parsePlanLifecycle('# Approved [APPROVED]')).toBe('approved');
    const discovered = discoverPlanReferences(projectRoot);
    expect(discovered.map(plan => [plan.title, plan.status])).toEqual([
      ['Active Work', 'draft'],
      ['Old Work', 'superseded'],
      ['Paused Work', 'paused'],
      ['Plan Lifecycle Index', 'reference'],
    ]);

    const context = documentService.getDocumentsForAgent('agent', 'workspace', projectRoot);
    expect(context).toContain('Active Work [DRAFT]');
    expect(context).not.toContain('Paused Work [PAUSED]');
    expect(context).not.toContain('Old Work [SUPERSEDED]');
    expect(context).toContain('Paused, completed, superseded, and reference material is cataloged');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('existing plans are reconstructed from disk while missing-source recovery records are deduplicated', async () => {
  const map: Map<string, LiveDocument> = (globalThis as any).__documentsMap;
  const original = documentService.getAll().map(doc => structuredClone(doc));
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-forge-plan-persistence-'));
  const plansDir = join(projectRoot, '.plans');
  const filePath = join(plansDir, 'durable.md');
  await mkdir(plansDir);
  await writeFile(filePath, '# Durable\n\n> Lifecycle: Draft\n');
  const now = Date.now();
  const record = (id: string, path: string, updatedAt: number): LiveDocument => ({
    id,
    title: 'Durable',
    content: '# Durable',
    status: 'draft',
    filePath: path,
    lastEditedBy: 'user',
    createdAt: now,
    updatedAt,
  });

  try {
    documentService.load([
      record('older', filePath, now),
      record('newer', resolve(filePath), now + 1),
      record('missing-older', join(plansDir, 'missing.md'), now + 2),
      record('missing-newer', resolve(join(plansDir, 'missing.md')), now + 3),
    ]);
    expect(documentService.getAll().map(doc => doc.id)).toEqual(['missing-newer']);
    expect(canonicalPlanPath(documentService.getAll()[0]!.filePath!))
      .toBe(canonicalPlanPath(join(plansDir, 'missing.md')));
    expect(documentService.buildPersistedDocuments().map(doc => doc.id)).toEqual(['missing-newer']);
  } finally {
    map.clear();
    for (const doc of original) map.set(doc.id, doc);
    await rm(projectRoot, { recursive: true, force: true });
  }
});
