import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { LiveDocument } from '../../shared/protocol';
import { documentService } from './document.service';
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
