import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    expect(created.cwd).toBe(projectRoot);
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
      qaSurfaceVerifications: { surface: 123 },
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

test('restart recovery durably finalizes interrupted QA and pauses Atlas exactly once', async () => {
  const map: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap;
  const originalEntries = [...map.entries()];
  const originalSettings = structuredClone(settingsService.getRef());
  const originalSaveNow = persistenceService.saveNow;
  let saveCalls = 0;
  const now = Date.now();
  const recovered: any = {
    ...workspace(`recovery-${randomUUID()}`, 0, now),
    qaRuns: [{
      id: 'qa-interrupted',
      sourceAgentId: 'agent-1',
      prompt: 'verify',
      status: 'running',
      queuedAt: now - 100,
      startedAt: now - 50,
      handoffStartedAt: now - 25,
    }],
    atlasRun: {
      id: 'atlas-interrupted',
      status: 'validating',
      candidateRelPath: 'docs/.agent-forge-atlas-candidates/atlas-interrupted',
      startedAt: now - 100,
    },
  };
  map.clear();
  persistenceService.saveNow = async () => { saveCalls++; };

  try {
    await workspaceService.loadAndMigrate([recovered], {}, [], () => {});
    expect(recovered.qaRuns[0]).toMatchObject({
      status: 'failed',
      verdict: 'inconclusive',
      error: 'Interrupted by server restart; run it again to obtain a trustworthy result.',
      handoffError: 'Agent Forge restarted before the QA handoff completed. Try sending it again.',
    });
    expect(recovered.qaRuns[0].handoffStartedAt).toBeUndefined();
    expect(recovered.atlasRun).toMatchObject({
      status: 'paused',
      error: 'Agent Forge restarted before this Atlas run completed. Resume to continue from its candidate checkpoint.',
    });
    expect(saveCalls).toBe(1);

    await workspaceService.loadAndMigrate([recovered], {}, [], () => {});
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

test('restart recovery recognizes a canonical Atlas published before state persistence', async () => {
  const map: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap;
  const originalEntries = [...map.entries()];
  const originalSettings = structuredClone(settingsService.getRef());
  const originalSaveNow = persistenceService.saveNow;
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-forge-published-recovery-'));
  const atlasRoot = join(projectRoot, 'docs', 'ui-atlas');
  const runId = `published-${randomUUID()}`;
  const publishedAt = Date.now() - 1_000;
  let saveCalls = 0;
  const recovered: any = {
    ...workspace(`published-workspace-${randomUUID()}`, 0, Date.now()),
    atlasProjectCwd: projectRoot,
    atlasRun: {
      id: runId,
      mode: 'build',
      status: 'validating',
      candidateRelPath: `docs/.agent-forge-atlas-candidates/${runId}`,
      browserSessionId: `atlas-${runId}`,
      createdAt: publishedAt - 100,
      startedAt: publishedAt - 50,
      lastActivityAt: publishedAt - 25,
    },
  };
  await mkdir(atlasRoot, { recursive: true });
  await writeFile(join(atlasRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    atlasSchemaVersion: 1,
    runId,
    status: 'complete',
    generatedAt: new Date(publishedAt).toISOString(),
  }));
  map.clear();
  persistenceService.saveNow = async () => { saveCalls++; };

  try {
    await workspaceService.loadAndMigrate([recovered], {}, [], () => {});
    expect(recovered.atlasRun).toMatchObject({
      id: runId,
      status: 'completed',
      phase: 'published',
      error: undefined,
    });
    expect(recovered.atlasLastScanAt).toBe(publishedAt);
    expect(saveCalls).toBe(1);
  } finally {
    persistenceService.saveNow = originalSaveNow;
    map.clear();
    for (const [id, value] of originalEntries) map.set(id, value);
    settingsService.load(originalSettings);
    await rm(projectRoot, { recursive: true, force: true });
  }
});
