import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceInfo } from '../../shared/protocol';
import { persistenceService } from './persistence.service';
import { settingsService } from './settings.service';
import { sortWorkspaces, workspaceService } from './workspace.service';

function workspace(id: string, sortOrder: number, createdAt: number): WorkspaceInfo {
  return {
    id,
    name: id,
    sortOrder,
    createdAt,
    gridColumns: 2,
    gridRows: 2,
    selectedAgentIds: [],
    lockedAgentIds: [],
  };
}

test('workspace ordering follows persisted sortOrder with createdAt as a stable fallback', () => {
  const sorted = sortWorkspaces([
    workspace('third', 2, 1),
    workspace('second-newer', 1, 20),
    workspace('first', 0, 30),
    workspace('second-older', 1, 10),
  ]);
  expect(sorted.map(item => item.id)).toEqual(['first', 'second-older', 'second-newer', 'third']);
});

test('workspace creation persists a validated primary working directory', async () => {
  const map: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap;
  const originalSettings = structuredClone(settingsService.getRef());
  const originalSaveNow = persistenceService.saveNow;
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-forge-workspace-root-'));
  const filePath = join(projectRoot, 'not-a-directory.txt');
  let createdId: string | undefined;
  await writeFile(filePath, 'test');
  persistenceService.saveNow = async () => {};

  try {
    const created = await workspaceService.create('Project', `  ${projectRoot}  `);
    createdId = created.id;
    expect(created.cwd).toBe(await realpath(projectRoot));
    await expect(workspaceService.create('Relative', '.')).rejects.toThrow('must be an absolute path');
    await expect(workspaceService.create('Empty', '   ')).rejects.toThrow('must be an absolute path');
    await expect(workspaceService.create('File', filePath)).rejects.toThrow('does not exist or is not a directory');
    await expect(workspaceService.create('Missing', join(projectRoot, 'missing'))).rejects.toThrow('does not exist or is not a directory');
  } finally {
    if (createdId) map.delete(createdId);
    persistenceService.saveNow = originalSaveNow;
    settingsService.load(originalSettings);
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('workspace mutations restore maps, ordering, settings, and reassignments when persistence fails', async () => {
  const map: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap;
  const first = workspace(`atomic-a-${randomUUID()}`, 1000, Date.now());
  const second = workspace(`atomic-b-${randomUUID()}`, 1001, Date.now() + 1);
  const originalSettings = structuredClone(settingsService.getRef());
  const originalSaveNow = persistenceService.saveNow;
  map.set(first.id, first);
  map.set(second.id, second);
  settingsService.getRef().activeWorkspaceId = first.id;
  persistenceService.saveNow = async () => { throw new Error('disk full'); };

  try {
    const idsBeforeCreate = [...map.keys()];
    await expect(workspaceService.create('ghost', tmpdir())).rejects.toThrow('disk full');
    expect([...map.keys()]).toEqual(idsBeforeCreate);
    expect(settingsService.getRef().activeWorkspaceId).toBe(first.id);

    const firstBeforeUpdate = structuredClone(first);
    const selected = ['agent-a'];
    await expect(workspaceService.update(first.id, {
      name: 'uncommitted',
      selectedAgentIds: selected,
      testUrl: 'http://localhost:5173',
    })).rejects.toThrow('disk full');
    selected.push('external-mutation');
    expect(first).toEqual(firstBeforeUpdate);

    const ordersBefore = new Map([...map.values()].map(item => [item.id, item.sortOrder]));
    await expect(workspaceService.reorder([second.id, first.id])).rejects.toThrow('disk full');
    expect(new Map([...map.values()].map(item => [item.id, item.sortOrder]))).toEqual(ordersBefore);

    settingsService.getRef().activeWorkspaceId = second.id;
    await expect(workspaceService.setActive(first.id)).rejects.toThrow('disk full');
    expect(settingsService.getRef().activeWorkspaceId).toBe(second.id);

    settingsService.getRef().activeWorkspaceId = first.id;
    let assignedWorkspace = first.id;
    await expect(workspaceService.delete(first.id, (_from, to) => {
      const previous = assignedWorkspace;
      assignedWorkspace = to;
      return () => { assignedWorkspace = previous; };
    })).rejects.toThrow('disk full');
    expect(map.get(first.id)).toBe(first);
    expect(assignedWorkspace).toBe(first.id);
    expect(settingsService.getRef().activeWorkspaceId).toBe(first.id);
  } finally {
    persistenceService.saveNow = originalSaveNow;
    map.delete(first.id);
    map.delete(second.id);
    settingsService.load(originalSettings);
  }
});

test('restart migration drops legacy Atlas, QA, and tracker workspace state exactly once', async () => {
  const map: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap;
  const originalEntries = [...map.entries()];
  const originalSettings = structuredClone(settingsService.getRef());
  const originalSaveNow = persistenceService.saveNow;
  let saveCalls = 0;
  const now = Date.now();
  const legacy: any = {
    ...workspace(`legacy-features-${randomUUID()}`, 0, now),
    testUrl: 'http://localhost:5173',
    googleDocsTrackerEnabled: true,
    qaAgentId: 'qa-agent',
    qaRuns: [{ id: 'qa-1', status: 'running' }],
    qaSurfaceVerifications: { 'surface.home': now },
    atlasAgentId: 'atlas-agent',
    atlasProjectCwd: '/tmp/example-project',
    atlasLastScanAt: now,
    atlasRun: { id: 'atlas-1', status: 'running' },
  };
  map.clear();
  persistenceService.saveNow = async () => { saveCalls++; };

  try {
    await workspaceService.loadAndMigrate([legacy], {}, [], () => {});
    for (const key of ['googleDocsTrackerEnabled', 'qaAgentId', 'qaRuns', 'qaSurfaceVerifications', 'atlasAgentId', 'atlasProjectCwd', 'atlasLastScanAt', 'atlasRun']) {
      expect(key in legacy).toBe(false);
    }
    expect(legacy.testUrl).toBe('http://localhost:5173');
    expect(saveCalls).toBe(1);

    await workspaceService.loadAndMigrate([legacy], {}, [], () => {});
    expect(saveCalls).toBe(1);
  } finally {
    persistenceService.saveNow = originalSaveNow;
    map.clear();
    for (const [id, value] of originalEntries) map.set(id, value);
    settingsService.load(originalSettings);
  }
});

test('fresh-state migration persists the default workspace and agent assignments', async () => {
  const map: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap;
  const originalEntries = [...map.entries()];
  const originalSettings = structuredClone(settingsService.getRef());
  const originalSaveNow = persistenceService.saveNow;
  const assignments: Array<[string, string]> = [];
  let saveCalls = 0;
  map.clear();
  persistenceService.saveNow = async () => { saveCalls++; };

  try {
    await workspaceService.loadAndMigrate(undefined, { gridColumns: 4, gridRows: 3 }, [
      { id: 'agent-a', cwd: 'C:\\projects\\alpha' },
      { id: 'agent-b', cwd: 'C:\\projects\\beta' },
    ], (agentId, workspaceId) => {
      assignments.push([agentId, workspaceId]);
    });
    const created = workspaceService.getAll();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'Default',
      cwd: 'C:\\projects\\alpha',
      gridColumns: 4,
      gridRows: 3,
      selectedAgentIds: ['agent-a', 'agent-b'],
    });
    expect(assignments).toEqual([
      ['agent-a', created[0]!.id],
      ['agent-b', created[0]!.id],
    ]);
    expect(settingsService.getRef().activeWorkspaceId).toBe(created[0]!.id);
    expect(saveCalls).toBe(1);
  } finally {
    persistenceService.saveNow = originalSaveNow;
    map.clear();
    for (const [id, value] of originalEntries) map.set(id, value);
    settingsService.load(originalSettings);
  }
});

test('legacy workspaces inherit their primary directory from an assigned agent', async () => {
  const map: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap;
  const originalEntries = [...map.entries()];
  const originalSettings = structuredClone(settingsService.getRef());
  const originalSaveNow = persistenceService.saveNow;
  const legacy = workspace(`legacy-${randomUUID()}`, 0, Date.now());
  let saveCalls = 0;
  map.clear();
  persistenceService.saveNow = async () => { saveCalls++; };

  try {
    await workspaceService.loadAndMigrate([legacy], {}, [
      { id: 'agent-a', cwd: 'C:\\projects\\legacy', workspaceId: legacy.id },
    ], () => {});
    expect(legacy.cwd).toBe('C:\\projects\\legacy');
    expect(saveCalls).toBe(1);
  } finally {
    persistenceService.saveNow = originalSaveNow;
    map.clear();
    for (const [id, value] of originalEntries) map.set(id, value);
    settingsService.load(originalSettings);
  }
});
