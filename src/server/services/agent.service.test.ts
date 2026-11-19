import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceInfo } from '../../shared/protocol';
import { agentService } from './agent.service';
import { documentService } from './document.service';
import { persistenceService } from './persistence.service';
import { resolveAgentModel } from '../agents/registry';

function loadTestAgent(id: string, cwd: string, overrides: Record<string, unknown> = {}, loadedMessages: any[] = []): void {
  agentService.load({
    agents: [{
      id,
      name: 'Reliability Agent',
      cwd,
      referencePaths: [],
      systemPrompt: '',
      status: 'idle',
      createdAt: Date.now(),
      workspaceId: '',
      provider: 'codex',
      ...overrides,
    }],
    messages: loadedMessages,
    sharedContext: '',
  });
}

test('restart preserves ready agents and finished outcomes, interrupting only active turns', async () => {
  // A missing fictional directory keeps this status-only test free of real watchers.
  const directory = join(tmpdir(), `forge-restored-status-${randomUUID()}`);
  const originalSaveNow = persistenceService.saveNow;
  const originalStart = documentService.startPlansWatcher;
  const originalStop = documentService.stopPlansWatcher;
  const originalRelease = documentService.releaseLocksForAgent;
  const ids: string[] = [];
  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async () => {};
  try {
    for (const status of ['idle', 'error', 'stopped', 'working', 'thinking'] as const) {
      for (const outcome of [undefined, 'completed', 'failed', 'stopped'] as const) {
        const id = `restored-${randomUUID()}`;
        ids.push(id);
        const lastTurnOutcome = outcome ? { status: outcome, at: 123, detail: 'Saved outcome' } : undefined;
        loadTestAgent(id, directory, { status, lastTurnOutcome });
        const restored = agentService.getAgent(id)!;
        const interrupted = status === 'working' || status === 'thinking';
        expect(restored.status).toBe(interrupted ? 'stopped' : status);
        if (interrupted) {
          expect(restored.lastTurnOutcome).toMatchObject({ status: 'stopped', detail: 'Interrupted by server restart' });
          expect(restored.lastTurnOutcome!.at).toBeGreaterThan(123);
        } else {
          expect(restored.lastTurnOutcome).toEqual(lastTurnOutcome);
        }
        expect(agentService.buildPersistedAgents().find(agent => agent.id === id)?.status).toBe(restored.status);
      }
    }
  } finally {
    for (const id of ids) await agentService.removeAgent(id);
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStart;
    documentService.stopPlansWatcher = originalStop;
    documentService.releaseLocksForAgent = originalRelease;
  }
});

test('Kill All still stops every agent, including ready agents, and persists stopped statuses', async () => {
  const { chatService } = await import('./chat.service');
  const map: Map<string, any> = (globalThis as any).__agentsMap;
  const previous = [...map.entries()];
  map.clear();
  for (const status of ['idle', 'working', 'thinking', 'error', 'stopped']) {
    map.set(status, { info: { id: status, status } });
  }
  const kill = spyOn(chatService, 'kill').mockImplementation(() => {});
  const reset = spyOn(chatService, 'resetLock').mockImplementation(() => {});
  const pids = spyOn(persistenceService, 'getActivePids').mockReturnValue(new Set());
  const savePids = spyOn(persistenceService, 'savePidsNow').mockResolvedValue();
  const save = spyOn(persistenceService, 'saveNow').mockImplementation(async () => {
    expect(agentService.buildPersistedAgents().every(agent => agent.status === 'stopped')).toBe(true);
  });
  const release = spyOn(documentService, 'releaseLocksForAgent').mockResolvedValue();
  try {
    expect((await agentService.killAllProcesses()).success).toBe(true);
    expect(kill).toHaveBeenCalledTimes(5);
    expect(reset).toHaveBeenCalledTimes(5);
    expect(release).toHaveBeenCalledTimes(5);
    expect(save).toHaveBeenCalledTimes(1);
    expect(savePids).toHaveBeenCalledTimes(1);
  } finally {
    for (const mock of [kill, reset, pids, savePids, save, release]) mock.mockRestore();
    map.clear();
    for (const [id, value] of previous) map.set(id, value);
  }
});

test('failed creation removes the agent, workspace slot, and both watchers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-create-atomic-'));
  const workspaceId = `workspace-${randomUUID()}`;
  const workspaceMap: Map<string, any> = (globalThis as any).__workspacesMap;
  const workspace: WorkspaceInfo = {
    id: workspaceId,
    name: 'Atomicity workspace',
    sortOrder: 999,
    gridColumns: 1,
    gridRows: 1,
    gridSizeManuallySet: false,
    selectedAgentIds: ['existing'],
    lockedAgentIds: [],
    createdAt: Date.now(),
  };
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const starts: string[] = [];
  const stops: string[] = [];
  workspaceMap.set(workspaceId, workspace);
  persistenceService.saveNow = async () => { throw new Error('agent write failed'); };
  documentService.startPlansWatcher = agentId => { starts.push(agentId); };
  documentService.stopPlansWatcher = agentId => { stops.push(agentId); };

  try {
    const idsBefore = new Set(agentService.getAgents().map(agent => agent.id));
    const selectionBefore = [...workspace.selectedAgentIds];
    await expect(agentService.createAgent('Ghost agent', directory, [], '', workspaceId)).rejects.toThrow('agent write failed');
    expect(new Set(agentService.getAgents().map(agent => agent.id))).toEqual(idsBefore);
    expect(workspace.selectedAgentIds).toEqual(selectionBefore);
    expect([workspace.gridColumns, workspace.gridRows, workspace.gridSizeManuallySet]).toEqual([1, 1, false]);
    expect(workspace.cwd).toBeUndefined();
    expect(starts).toHaveLength(1);
    expect(stops).toEqual(starts);
  } finally {
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    workspaceMap.delete(workspaceId);
    await rm(directory, { recursive: true, force: true });
  }
});

test('the first agent durably supplies a missing legacy workspace directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-workspace-cwd-'));
  const workspaceId = `workspace-cwd-${randomUUID()}`;
  const workspaceMap: Map<string, any> = (globalThis as any).__workspacesMap;
  const workspace: WorkspaceInfo = {
    id: workspaceId,
    name: 'Fresh default workspace',
    sortOrder: 998,
    gridColumns: 2,
    gridRows: 2,
    selectedAgentIds: [],
    lockedAgentIds: [],
    createdAt: Date.now(),
  };
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const originalReleaseLocks = documentService.releaseLocksForAgent;
  let createdAgentId: string | undefined;
  workspaceMap.set(workspaceId, workspace);
  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async () => {};

  try {
    const created = await agentService.createAgent('First agent', directory, [], '', workspaceId);
    createdAgentId = created.id;
    expect(workspace.cwd).toBe(await realpath(directory));
    expect(workspace.selectedAgentIds).toContain(created.id);
  } finally {
    if (createdAgentId && agentService.getAgent(createdAgentId)) {
      await agentService.removeAgent(createdAgentId).catch(() => false);
    }
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    documentService.releaseLocksForAgent = originalReleaseLocks;
    workspaceMap.delete(workspaceId);
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed agent update restores metadata, session identity, and old-directory watchers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-forge-update-atomic-'));
  const oldCwd = join(root, 'old cwd');
  const newCwd = join(root, 'new cwd');
  await Bun.write(join(oldCwd, '.keep'), 'old');
  await Bun.write(join(newCwd, '.keep'), 'new');
  const id = `update-atomic-${randomUUID()}`;
  const originalSave = persistenceService.save;
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const originalReleaseLocks = documentService.releaseLocksForAgent;
  const starts: string[] = [];
  const stops: string[] = [];
  persistenceService.save = () => {};
  documentService.startPlansWatcher = (_agentId, cwd) => { starts.push(cwd); };
  documentService.stopPlansWatcher = () => { stops.push(id); };
  documentService.releaseLocksForAgent = async () => {};

  try {
    loadTestAgent(id, oldCwd, { model: 'gpt-5.6-sol' });
    agentService.setCurrentSession(id, 'codex', 'gpt-5.6-sol', 'session-durable');
    agentService.setModelMismatch(id, 'gpt-5.6-sol', 'gpt-5.5');
    const before = structuredClone(agentService.getAgent(id)!);
    starts.length = 0;
    stops.length = 0;
    persistenceService.saveNow = async () => { throw new Error('agent update failed'); };

    await expect(agentService.updateAgent(id, {
      name: 'Uncommitted name',
      cwd: newCwd,
      model: 'gpt-5.5',
      referencePaths: ['C:\\uncommitted'],
    })).rejects.toThrow('agent update failed');

    expect(agentService.getAgent(id)).toEqual(before);
    expect(agentService.getCurrentSessionId(id)).toBe('session-durable');
    expect(agentService.getCurrentSessionProvider(id)).toBe('codex');
    expect(agentService.getCurrentSessionModel(id)).toBe('gpt-5.6-sol');
    expect(stops).toEqual([id, id]);
    expect(starts).toEqual([newCwd, oldCwd]);
  } finally {
    persistenceService.saveNow = async () => {};
    if (agentService.getAgent(id)) await agentService.removeAgent(id).catch(() => false);
    persistenceService.save = originalSave;
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    documentService.releaseLocksForAgent = originalReleaseLocks;
    await rm(root, { recursive: true, force: true });
  }
});

test('failed removal restores the agent and workspace membership without firing onRemoved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-remove-atomic-'));
  const id = `remove-atomic-${randomUUID()}`;
  const workspaceId = `workspace-${randomUUID()}`;
  const workspaceMap: Map<string, any> = (globalThis as any).__workspacesMap;
  const workspace: WorkspaceInfo = {
    id: workspaceId,
    name: 'Removal atomicity',
    sortOrder: 998,
    gridColumns: 1,
    gridRows: 1,
    selectedAgentIds: [id],
    lockedAgentIds: [id],
    createdAt: Date.now(),
  };
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const originalReleaseLocks = documentService.releaseLocksForAgent;
  let removedNotifications = 0;
  workspaceMap.set(workspaceId, workspace);
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async () => {};
  agentService.onAgentRemoved(agentId => { if (agentId === id) removedNotifications++; });

  try {
    loadTestAgent(id, directory, { workspaceId });
    persistenceService.saveNow = async () => { throw new Error('remove write failed'); };
    await expect(agentService.removeAgent(id)).rejects.toThrow('remove write failed');
    expect(agentService.getAgent(id)?.id).toBe(id);
    expect(workspace.selectedAgentIds).toEqual([id]);
    expect(workspace.lockedAgentIds).toEqual([id]);
    expect(removedNotifications).toBe(0);
  } finally {
    persistenceService.saveNow = async () => {};
    if (agentService.getAgent(id)) await agentService.removeAgent(id).catch(() => false);
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    documentService.releaseLocksForAgent = originalReleaseLocks;
    workspaceMap.delete(workspaceId);
    await rm(directory, { recursive: true, force: true });
  }
});

test('simultaneous removal requests execute cleanup and lifecycle completion exactly once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-remove-'));
  const id = `remove-${randomUUID()}`;
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const originalReleaseLocks = documentService.releaseLocksForAgent;
  let targetReleaseCalls = 0;
  let targetStopWatcherCalls = 0;
  let removedNotifications = 0;
  let releaseGate!: () => void;
  let signalReleaseStarted!: () => void;
  const releaseStarted = new Promise<void>(resolve => { signalReleaseStarted = resolve; });
  const releaseAllowed = new Promise<void>(resolve => { releaseGate = resolve; });

  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = agentId => {
    if (agentId === id) targetStopWatcherCalls++;
  };
  documentService.releaseLocksForAgent = async agentId => {
    if (agentId !== id) return;
    targetReleaseCalls++;
    signalReleaseStarted();
    await releaseAllowed;
  };
  agentService.onAgentRemoved(agentId => {
    if (agentId === id) removedNotifications++;
  });

  try {
    loadTestAgent(id, directory);
    const first = agentService.removeAgent(id);
    await releaseStarted;
    const second = agentService.removeAgent(id);
    releaseGate();

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(targetReleaseCalls).toBe(1);
    expect(targetStopWatcherCalls).toBe(1);
    expect(removedNotifications).toBe(1);
    expect(await agentService.removeAgent(id)).toBe(false);
  } finally {
    releaseGate();
    if (agentService.getAgent(id)) await agentService.removeAgent(id).catch(() => false);
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    documentService.releaseLocksForAgent = originalReleaseLocks;
    await rm(directory, { recursive: true, force: true });
  }
});

test('changing an agent cwd moves both its general watcher and plans watcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-forge-cwd-'));
  const oldCwd = join(root, 'old cwd');
  const newCwd = join(root, 'new cwd');
  await Bun.write(join(oldCwd, '.keep'), 'old');
  await Bun.write(join(newCwd, '.keep'), 'new');
  const id = `cwd-${randomUUID()}`;
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const originalReleaseLocks = documentService.releaseLocksForAgent;
  const starts: Array<{ agentId: string; cwd: string }> = [];
  const stops: string[] = [];

  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = (agentId, cwd) => { starts.push({ agentId, cwd }); };
  documentService.stopPlansWatcher = agentId => { stops.push(agentId); };
  documentService.releaseLocksForAgent = async () => {};

  try {
    loadTestAgent(id, oldCwd);
    starts.length = 0;
    stops.length = 0;

    const updated = await agentService.updateAgent(id, { cwd: newCwd });

    expect(updated?.cwd).toBe(newCwd);
    expect(stops).toEqual([id]);
    expect(starts).toEqual([{ agentId: id, cwd: newCwd }]);
  } finally {
    if (agentService.getAgent(id)) await agentService.removeAgent(id).catch(() => false);
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    documentService.releaseLocksForAgent = originalReleaseLocks;
    await rm(root, { recursive: true, force: true });
  }
});

test('agent updates reject invalid provider-scoped selections without changing metadata or session identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-selection-validation-'));
  const id = `selection-validation-${randomUUID()}`;
  const originalSave = persistenceService.save;
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const originalReleaseLocks = documentService.releaseLocksForAgent;
  persistenceService.save = () => {};
  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async () => {};

  try {
    loadTestAgent(id, directory, {
      model: 'gpt-5.6-sol',
      reasoningLevel: 'high',
      modelMismatch: { requested: 'gpt-5.6-sol', ran: 'gpt-5.5', at: Date.now() },
    });
    agentService.setCurrentSession(id, 'codex', 'gpt-5.6-sol', 'selection-session');
    const before = structuredClone(agentService.getAgent(id)!);

    await expect(agentService.updateAgent(id, { provider: 'missing-provider' as any }))
      .rejects.toThrow('Unsupported agent provider');
    await expect(agentService.updateAgent(id, { model: 'not-a-real-model' }))
      .rejects.toThrow('Unsupported codex model');
    await expect(agentService.updateAgent(id, { reasoningLevel: 'impossibly-deep' }))
      .rejects.toThrow('Unsupported codex reasoning level');
    await expect(agentService.updateAgent(id, { provider: 'claude', reasoningLevel: 'high' }))
      .rejects.toThrow('Unsupported claude reasoning level');

    expect(agentService.getAgent(id)).toEqual(before);
    expect(agentService.getCurrentSessionId(id)).toBe('selection-session');
    expect(agentService.getCurrentSessionProvider(id)).toBe('codex');
    expect(agentService.getCurrentSessionModel(id)).toBe('gpt-5.6-sol');
  } finally {
    if (agentService.getAgent(id)) await agentService.removeAgent(id).catch(() => false);
    persistenceService.save = originalSave;
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    documentService.releaseLocksForAgent = originalReleaseLocks;
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider-only agent updates select provider defaults and clear incompatible sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-provider-swap-'));
  const id = `provider-swap-${randomUUID()}`;
  const originalSave = persistenceService.save;
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const originalReleaseLocks = documentService.releaseLocksForAgent;
  persistenceService.save = () => {};
  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async () => {};

  try {
    loadTestAgent(id, directory, { model: 'gpt-5.6-sol', reasoningLevel: 'high' });
    agentService.setCurrentSession(id, 'codex', 'gpt-5.6-sol', 'provider-swap-session');

    const updated = await agentService.updateAgent(id, { provider: 'claude' });

    expect(updated?.provider).toBe('claude');
    expect(updated?.model).toBe(resolveAgentModel('claude'));
    expect(updated?.reasoningLevel).toBeUndefined();
    expect(agentService.getCurrentSessionId(id)).toBeNull();
    expect(agentService.getCurrentSessionProvider(id)).toBeNull();
    expect(agentService.getCurrentSessionModel(id)).toBeNull();
  } finally {
    if (agentService.getAgent(id)) await agentService.removeAgent(id).catch(() => false);
    persistenceService.save = originalSave;
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    documentService.releaseLocksForAgent = originalReleaseLocks;
    await rm(directory, { recursive: true, force: true });
  }
});

test('history and shared-context mutations roll back completely when persistence fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-history-atomic-'));
  const id = `history-atomic-${randomUUID()}`;
  const originalSave = persistenceService.save;
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const originalReleaseLocks = documentService.releaseLocksForAgent;
  const originalSharedContext = agentService.getSharedContext();
  persistenceService.save = () => {};
  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async () => {};

  try {
    loadTestAgent(id, directory, {
      model: 'gpt-5.6-sol',
      modelMismatch: { requested: 'gpt-5.6-sol', ran: 'gpt-5.5', at: Date.now() },
      lastTurnOutcome: { status: 'failed', reason: 'provider failure', at: Date.now() },
    });
    const message = agentService.appendMessage(id, 'user', 'durable history');
    agentService.setCurrentSession(id, 'codex', 'gpt-5.6-sol', 'history-session');
    await agentService.updateSharedContext('durable shared context');
    const beforeInfo = structuredClone(agentService.getAgent(id)!);

    persistenceService.saveNow = async () => { throw new Error('injected persistence failure'); };
    await expect(agentService.clearHistory(id)).rejects.toThrow('injected persistence failure');
    await expect(agentService.updateSharedContext('uncommitted shared context')).rejects.toThrow('injected persistence failure');

    expect(agentService.getMessages(id)).toEqual([message]);
    expect(agentService.getAgent(id)).toEqual(beforeInfo);
    expect(agentService.getCurrentSessionId(id)).toBe('history-session');
    expect(agentService.getCurrentSessionProvider(id)).toBe('codex');
    expect(agentService.getCurrentSessionModel(id)).toBe('gpt-5.6-sol');
    expect(agentService.getSharedContext()).toBe('durable shared context');
  } finally {
    persistenceService.saveNow = async () => {};
    await agentService.updateSharedContext(originalSharedContext).catch(() => {});
    if (agentService.getAgent(id)) await agentService.removeAgent(id).catch(() => false);
    persistenceService.save = originalSave;
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    documentService.releaseLocksForAgent = originalReleaseLocks;
    await rm(directory, { recursive: true, force: true });
  }
});

test('non-finite usage updates cannot poison an agent accounting snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-usage-'));
  const id = `usage-${randomUUID()}`;
  const originalSave = persistenceService.save;
  const originalSaveNow = persistenceService.saveNow;
  const originalStartPlansWatcher = documentService.startPlansWatcher;
  const originalStopPlansWatcher = documentService.stopPlansWatcher;
  const originalReleaseLocks = documentService.releaseLocksForAgent;
  persistenceService.save = () => {};
  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async () => {};

  try {
    loadTestAgent(id, directory);
    const before = agentService.getTokenUsage(id)!;
    agentService.applyUsage(id, {
      contextTokens: Number.POSITIVE_INFINITY,
      contextLimit: Number.POSITIVE_INFINITY,
      inputTokensDelta: Number.NaN,
      outputTokensDelta: Number.POSITIVE_INFINITY,
      costUsdDelta: Number.POSITIVE_INFINITY,
      turnsDelta: Number.POSITIVE_INFINITY,
    });
    expect(agentService.getTokenUsage(id)).toEqual(before);
  } finally {
    if (agentService.getAgent(id)) await agentService.removeAgent(id).catch(() => false);
    persistenceService.save = originalSave;
    persistenceService.saveNow = originalSaveNow;
    documentService.startPlansWatcher = originalStartPlansWatcher;
    documentService.stopPlansWatcher = originalStopPlansWatcher;
    documentService.releaseLocksForAgent = originalReleaseLocks;
    await rm(directory, { recursive: true, force: true });
  }
});

test('project directory changes start a new provider session and refuse active turns', async () => {
  const first = await mkdtemp(join(tmpdir(), 'forge-cwd-first-'));
  const second = await mkdtemp(join(tmpdir(), 'forge-cwd-second-'));
  const id = `cwd-${randomUUID()}`;
  const save = persistenceService.saveNow;
  persistenceService.saveNow = async () => {};
  try {
    loadTestAgent(id, first);
    agentService.setCurrentSession(id, 'codex', undefined, 'old-session');
    agentService.setStatus(id, 'working');
    await expect(agentService.updateAgent(id, { cwd: second })).rejects.toThrow('active turn');
    expect(agentService.getCurrentSessionId(id)).toBe('old-session');
    agentService.setStatus(id, 'idle');
    await agentService.updateAgent(id, { cwd: second });
    expect(agentService.getCurrentSessionId(id)).toBeNull();
    expect(agentService.getCurrentSessionProvider(id)).toBeNull();
    await agentService.removeAgent(id);
  } finally {
    persistenceService.saveNow = save;
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
