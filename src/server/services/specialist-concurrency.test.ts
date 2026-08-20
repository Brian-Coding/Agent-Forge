import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import type { WorkspaceInfo } from '../../shared/protocol';
import { agentService } from './agent.service';
import { atlasService } from './atlas.service';
import { atlasCandidatePaths, discardAtlasCandidate } from './atlas-artifacts';
import { documentService } from './document.service';
import { getArtifactRoot } from './artifact-paths';
import { getQaRunArtifactRoot } from './artifact-paths';
import { browserService } from './browser.service';
import { persistenceService } from './persistence.service';
import { qaService } from './qa.service';
import { QA_RESULT_END, QA_RESULT_START } from './qa-result';
import { workspaceService } from './workspace.service';

setDefaultTimeout(15_000);

const workspaceMap: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap;
const originalCreateAgent = agentService.createAgent;
const originalSendMessage = agentService.sendMessage;
const originalSave = persistenceService.save;
const originalSaveNow = persistenceService.saveNow;
const originalStartPlansWatcher = documentService.startPlansWatcher;
const originalStopPlansWatcher = documentService.stopPlansWatcher;
const originalReleaseLocks = documentService.releaseLocksForAgent;
const testWorkspaceIds = new Set<string>();
const testDirectories = new Set<string>();
let createGate: ReturnType<typeof deferred> | null = null;
let turnGate: ReturnType<typeof deferred> | null = null;
let specialistCreateCalls = 0;
let handoffGate: ReturnType<typeof deferred> | null = null;
let handoffCalls = 0;
let qaTurnResult: ((agentId: string, content: string) => Promise<void>) | null = null;
let atlasTurnResult: ((agentId: string, content: string) => Promise<void>) | null = null;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
}

async function makeWorkspace(options: { sourceAgent?: boolean } = {}): Promise<{
  workspaceId: string;
  projectRoot: string;
  sourceAgentId?: string;
}> {
  const workspaceId = `specialist-${randomUUID()}`;
  const projectRoot = await mkdtemp(join(tmpdir(), 'agent-forge-specialist-'));
  testDirectories.add(projectRoot);
  testWorkspaceIds.add(workspaceId);
  workspaceMap.set(workspaceId, {
    id: workspaceId,
    name: 'Specialist Reliability',
    sortOrder: 0,
    gridColumns: 2,
    gridRows: 2,
    selectedAgentIds: [],
    lockedAgentIds: [],
    createdAt: Date.now(),
    testUrl: 'http://127.0.0.1:4173',
    qaRuns: [],
  });

  if (!options.sourceAgent) return { workspaceId, projectRoot };
  const sourceAgentId = `source-${randomUUID()}`;
  agentService.load({
    agents: [{
      id: sourceAgentId,
      name: 'Coding Agent',
      cwd: projectRoot,
      referencePaths: [],
      systemPrompt: '',
      status: 'idle',
      createdAt: Date.now(),
      workspaceId,
      provider: 'codex',
    }],
    messages: [],
    sharedContext: '',
  });
  return { workspaceId, projectRoot, sourceAgentId };
}

beforeAll(() => {
  persistenceService.save = () => {};
  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async () => {};

  agentService.createAgent = async (...args) => {
    if (args[0] === 'QA Tester' || args[0] === 'UI Atlas Agent') {
      specialistCreateCalls++;
      if (createGate) await createGate.promise;
    }
    return originalCreateAgent.apply(agentService, args);
  };
  agentService.sendMessage = async (agentId, content, source, options) => {
    const name = agentService.getAgent(agentId)?.name;
    if (name === 'Coding Agent' && source === 'qa' && handoffGate) {
      handoffCalls++;
      await handoffGate.promise;
      return;
    }
    if (name === 'QA Tester' || name === 'UI Atlas Agent') {
      if (name === 'QA Tester' && qaTurnResult) {
        await qaTurnResult(agentId, content);
        return;
      }
      if (name === 'UI Atlas Agent' && atlasTurnResult) {
        await atlasTurnResult(agentId, content);
        return;
      }
      if (turnGate) await turnGate.promise;
      return;
    }
    return originalSendMessage.call(agentService, agentId, content, source, options);
  };
});

beforeEach(() => {
  specialistCreateCalls = 0;
  handoffCalls = 0;
  handoffGate = null;
  qaTurnResult = null;
  atlasTurnResult = null;
  createGate = null;
  turnGate = deferred();
});

afterEach(async () => {
  createGate?.resolve();
  turnGate?.resolve();
  await Bun.sleep(25);

  for (const workspaceId of [...testWorkspaceIds]) {
    const workspace = workspaceService.get(workspaceId);
    if (workspace?.atlasRun && workspace.atlasProjectCwd) {
      await discardAtlasCandidate(workspace.atlasProjectCwd, workspace.atlasRun.id).catch(() => {});
    }
    for (const agent of agentService.getAgents().filter(item => item.workspaceId === workspaceId)) {
      await agentService.removeAgent(agent.id).catch(() => false);
    }
    workspaceMap.delete(workspaceId);
    testWorkspaceIds.delete(workspaceId);
    await rm(join(getArtifactRoot(), 'qa', workspaceId), { recursive: true, force: true }).catch(() => {});
  }
  for (const directory of [...testDirectories]) {
    await rm(directory, { recursive: true, force: true });
    testDirectories.delete(directory);
  }
  const qaQueues: Map<string, unknown[]> = (globalThis as any).__structuredQaQueues;
  await waitFor(() => !qaQueues || qaQueues.size === 0).catch(() => {});
});

afterAll(() => {
  agentService.createAgent = originalCreateAgent;
  agentService.sendMessage = originalSendMessage;
  persistenceService.save = originalSave;
  persistenceService.saveNow = originalSaveNow;
  documentService.startPlansWatcher = originalStartPlansWatcher;
  documentService.stopPlansWatcher = originalStopPlansWatcher;
  documentService.releaseLocksForAgent = originalReleaseLocks;
});

test('simultaneous QA requests provision one hidden agent and enqueue two distinct runs', async () => {
  const { workspaceId, sourceAgentId } = await makeWorkspace({ sourceAgent: true });
  createGate = deferred();

  const first = qaService.sendQaMessage(workspaceId, sourceAgentId!, 'test the first flow');
  const second = qaService.sendQaMessage(workspaceId, sourceAgentId!, 'test the second flow');
  await waitFor(() => specialistCreateCalls === 1);
  await Bun.sleep(20);
  expect(specialistCreateCalls).toBe(1);
  createGate.resolve();

  const runs = await Promise.all([first, second]);
  const workspace = workspaceService.get(workspaceId)!;
  expect(new Set(runs.map(run => run.id)).size).toBe(2);
  expect(workspace.qaRuns).toHaveLength(2);
  expect(workspace.qaAgentId).toBeTruthy();
  expect(agentService.getAgents().filter(agent =>
    agent.workspaceId === workspaceId && agent.name === 'QA Tester')).toHaveLength(1);

  turnGate!.resolve();
  const qaQueues: Map<string, unknown[]> = (globalThis as any).__structuredQaQueues;
  await waitFor(() => qaQueues.size === 0);
  expect(workspaceService.get(workspaceId)?.qaRuns?.every(run =>
    run.status === 'failed' || run.status === 'completed' || run.status === 'cancelled')).toBe(true);
});

test('the QA pending limit remains exact under a simultaneous request burst', async () => {
  const { workspaceId, sourceAgentId } = await makeWorkspace({ sourceAgent: true });
  const first = await qaService.sendQaMessage(workspaceId, sourceAgentId!, 'run 0');
  expect(first.status).toBe('queued');

  const burst = await Promise.allSettled(Array.from({ length: 11 }, (_, index) =>
    qaService.sendQaMessage(workspaceId, sourceAgentId!, `run ${index + 1}`)));
  const fulfilled = burst.filter(result => result.status === 'fulfilled');
  const rejected = burst.filter(result => result.status === 'rejected');
  expect(fulfilled).toHaveLength(9);
  expect(rejected).toHaveLength(2);
  expect(rejected.every(result => String((result as PromiseRejectedResult).reason).includes('10 pending runs'))).toBe(true);
  expect(workspaceService.get(workspaceId)?.qaRuns).toHaveLength(10);
  expect(specialistCreateCalls).toBe(1);

  turnGate!.resolve();
  const qaQueues: Map<string, unknown[]> = (globalThis as any).__structuredQaQueues;
  await waitFor(() => qaQueues.size === 0);
});

test('simultaneous Atlas builds create one candidate and reject the duplicate start', async () => {
  const { workspaceId, projectRoot } = await makeWorkspace();
  createGate = deferred();

  const first = atlasService.provisionAtlasAgent(workspaceId, projectRoot);
  const second = atlasService.provisionAtlasAgent(workspaceId, projectRoot);
  await waitFor(() => specialistCreateCalls === 1);
  await Bun.sleep(20);
  expect(specialistCreateCalls).toBe(1);
  createGate.resolve();

  const settled = await Promise.allSettled([first, second]);
  expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(String((settled.find(result => result.status === 'rejected') as PromiseRejectedResult).reason))
    .toContain('already active');
  const workspace = workspaceService.get(workspaceId)!;
  expect(workspace.atlasRun?.status).toBe('running');
  expect(agentService.getAgents().filter(agent =>
    agent.workspaceId === workspaceId && agent.name === 'UI Atlas Agent')).toHaveLength(1);

  turnGate!.resolve();
  await waitFor(() => {
    const status = workspaceService.get(workspaceId)?.atlasRun?.status;
    return status === 'failed' || status === 'paused' || status === 'completed';
  });
});

test('QA provisioning failure removes the hidden agent instead of leaving an orphan', async () => {
  const { workspaceId, sourceAgentId } = await makeWorkspace({ sourceAgent: true });
  const priorSaveNow = persistenceService.saveNow;
  let calls = 0;
  persistenceService.saveNow = async () => {
    calls++;
    if (calls === 2) throw new Error('workspace link write failed');
  };

  try {
    await expect(qaService.sendQaMessage(workspaceId, sourceAgentId!, 'test provisioning rollback'))
      .rejects.toThrow('workspace link write failed');
    expect(workspaceService.get(workspaceId)?.qaAgentId).toBeUndefined();
    expect(agentService.getAgents().filter(agent =>
      agent.workspaceId === workspaceId && agent.name === 'QA Tester')).toEqual([]);
  } finally {
    persistenceService.saveNow = priorSaveNow;
  }
});

test('Atlas provisioning failure removes its agent and candidate directory', async () => {
  const { workspaceId, projectRoot } = await makeWorkspace();
  const priorSaveNow = persistenceService.saveNow;
  let calls = 0;
  persistenceService.saveNow = async () => {
    calls++;
    if (calls === 2) throw new Error('atlas link write failed');
  };

  try {
    await expect(atlasService.provisionAtlasAgent(workspaceId, projectRoot))
      .rejects.toThrow('atlas link write failed');
    expect(workspaceService.get(workspaceId)?.atlasAgentId).toBeUndefined();
    expect(workspaceService.get(workspaceId)?.atlasRun).toBeUndefined();
    expect(agentService.getAgents().filter(agent =>
      agent.workspaceId === workspaceId && agent.name === 'UI Atlas Agent')).toEqual([]);
    const candidates = join(projectRoot, 'docs', '.agent-forge-atlas-candidates');
    expect(await readdir(candidates).catch(() => [])).toEqual([]);
  } finally {
    persistenceService.saveNow = priorSaveNow;
  }
});

test('simultaneous QA handoffs dispatch a completed run at most once', async () => {
  const { workspaceId, sourceAgentId } = await makeWorkspace({ sourceAgent: true });
  const workspace = workspaceService.get(workspaceId)!;
  const runId = `handoff-${randomUUID()}`;
  workspace.qaRuns = [{
    id: runId,
    sourceAgentId: sourceAgentId!,
    prompt: 'test',
    status: 'completed',
    browserSessionId: `qa-${runId}`,
    createdAt: Date.now(),
    finishedAt: Date.now(),
    verdict: 'fail',
    summary: 'A regression was found',
    report: 'Evidence-backed report',
  }];
  handoffGate = deferred();

  const settled = await Promise.allSettled([
    qaService.handoffRun(workspaceId, runId),
    qaService.handoffRun(workspaceId, runId),
  ]);
  expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(handoffCalls).toBe(1);
  expect(workspace.qaRuns[0]?.handoffStartedAt).toBeNumber();

  handoffGate.resolve();
  await waitFor(() => !!workspaceService.get(workspaceId)?.qaRuns?.[0]?.handedOffAt);
  expect(workspaceService.get(workspaceId)?.qaRuns?.[0]?.handoffStartedAt).toBeUndefined();
});

test('an evidence-backed QA turn is corroborated, persisted, accounted, and projected to Atlas', async () => {
  const { workspaceId, projectRoot, sourceAgentId } = await makeWorkspace({ sourceAgent: true });
  const workspace = workspaceService.get(workspaceId)!;
  workspace.atlasProjectCwd = projectRoot;
  await mkdir(join(projectRoot, 'docs', 'ui-atlas'), { recursive: true });
  await writeFile(join(projectRoot, 'docs', 'ui-atlas', 'atlas.json'), JSON.stringify({
    surfaces: [{ id: 'surface.home' }],
  }));

  const originalGetStatus = browserService.getStatus;
  const originalGetConsoleOutput = browserService.getConsoleOutput;
  const originalGetNetworkOutput = browserService.getNetworkOutput;
  const originalCloseContext = browserService.closeContext;
  let closedSessions = 0;
  browserService.getStatus = async () => ({ running: true, url: 'http://127.0.0.1:4173', title: 'Home' });
  browserService.getConsoleOutput = async () => [];
  browserService.getNetworkOutput = async () => [{
    kind: 'response',
    url: 'http://127.0.0.1:4173',
    method: 'GET',
    status: 200,
    ok: true,
    timestamp: Date.now(),
  }];
  browserService.closeContext = async () => { closedSessions++; };

  qaTurnResult = async (agentId, content) => {
    const runId = content.match(/Run ID: ([a-zA-Z0-9_-]+)/)?.[1];
    if (!runId) throw new Error('QA trigger omitted its run ID');
    const screenshotRoot = getQaRunArtifactRoot(workspaceId, runId);
    const screenshot = join(screenshotRoot, 'home.png');
    await mkdir(screenshotRoot, { recursive: true });
    await writeFile(screenshot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    agentService.applyUsage(agentId, {
      inputTokensDelta: 120,
      outputTokensDelta: 45,
      costUsdDelta: 0.25,
    });
    const envelope = {
      schemaVersion: 1,
      runId,
      verdict: 'pass',
      summary: 'The home flow passed.',
      assertions: [{
        id: 'assert.home',
        name: 'Home renders',
        status: 'passed',
        evidenceIds: ['shot.home', 'console.clean'],
        atlasSurfaceIds: ['surface.home'],
      }],
      evidence: [
        { id: 'shot.home', kind: 'screenshot', label: 'Home', ref: screenshot },
        { id: 'console.clean', kind: 'console', label: 'Console clean', detail: 'No errors' },
      ],
      findings: [],
      atlasSurfaceIds: ['surface.home'],
    };
    agentService.appendMessage(agentId, 'assistant', `QA complete\n\n${QA_RESULT_START}\n${JSON.stringify(envelope)}\n${QA_RESULT_END}`);
  };

  try {
    const queued = await qaService.sendQaMessage(workspaceId, sourceAgentId!, 'verify the home flow');
    await waitFor(() => {
      const current = workspaceService.get(workspaceId);
      return current?.qaRuns?.find(run => run.id === queued.id)?.status === 'completed'
        && typeof current.qaSurfaceVerifications?.home === 'number'
        && closedSessions === 1;
    });
    const completed = workspaceService.get(workspaceId)!.qaRuns!.find(run => run.id === queued.id)!;
    expect(completed.verdict).toBe('pass');
    expect(completed.validationErrors).toEqual([]);
    expect(completed.evidence?.map(item => item.id)).toContain('evidence.harness-console');
    expect(completed.evidence?.map(item => item.id)).toContain('evidence.harness-network');
    expect(completed.usage).toEqual({ inputTokens: 120, outputTokens: 45, costUsd: 0.25 });
    expect(workspaceService.get(workspaceId)?.qaSurfaceVerifications?.home).toBeNumber();
    expect(closedSessions).toBe(1);
  } finally {
    qaTurnResult = null;
    browserService.getStatus = originalGetStatus;
    browserService.getConsoleOutput = originalGetConsoleOutput;
    browserService.getNetworkOutput = originalGetNetworkOutput;
    browserService.closeContext = originalCloseContext;
  }
});

test('a complete Atlas turn validates, atomically publishes, prunes stale verification state, and cleans its candidate', async () => {
  const { workspaceId, projectRoot } = await makeWorkspace();
  const workspace = workspaceService.get(workspaceId)!;
  workspace.qaSurfaceVerifications = { home: 100, stale: 200 };
  const originalCloseContext = browserService.closeContext;
  let closedSessions = 0;
  browserService.closeContext = async () => { closedSessions++; };

  atlasTurnResult = async (_agentId, content) => {
    const runId = content.match(/Run ID: ([a-zA-Z0-9_-]+)/)?.[1];
    if (!runId) throw new Error('Atlas trigger omitted its run ID');
    const paths = atlasCandidatePaths(projectRoot, runId);
    await mkdir(join(paths.candidateRoot, 'shots'), { recursive: true });
    await writeFile(join(paths.candidateRoot, 'shots', 'surface-home.png'), Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
    await writeFile(join(paths.candidateRoot, 'atlas.md'), [
      '---',
      'schema_version: 1',
      'last_full_scan: 2026-08-12T12:00:00.000Z',
      'total_surfaces: 1',
      'total_entities: 1',
      '---',
      '# UI Atlas — Integration',
      '### `surface.home` — Home',
      '- Screenshot: `shots/surface-home.png`',
    ].join('\n'));
    await writeFile(join(paths.candidateRoot, 'atlas.json'), JSON.stringify({
      schemaVersion: 1,
      runId,
      generatedAt: '2026-08-12T12:00:00.000Z',
      entities: [{ id: 'entity.user', name: 'User' }],
      surfaces: [{
        id: 'surface.home',
        name: 'Home',
        status: 'verified',
        screenshotRefs: ['shots/surface-home.png'],
        entityIds: ['entity.user'],
      }],
      flows: [],
    }));
    await writeFile(join(paths.candidateRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      atlasSchemaVersion: 1,
      runId,
      status: 'complete',
      generatedAt: '2026-08-12T12:00:00.000Z',
    }));
    await writeFile(join(paths.candidateRoot, 'checkpoint.json'), JSON.stringify({
      schemaVersion: 1,
      runId,
      status: 'complete',
      phase: 'complete',
      completedSurfaceIds: ['surface.home'],
      lastActivityAt: '2026-08-12T12:00:00.000Z',
    }));
    await writeFile(join(paths.candidateRoot, 'README.md'), '# Atlas');
    await writeFile(join(paths.candidateRoot, 'changelog.md'), '# Changes');
  };

  try {
    const agent = await atlasService.provisionAtlasAgent(workspaceId, projectRoot);
    await waitFor(() => workspaceService.get(workspaceId)?.atlasRun?.status === 'completed');
    // Completion state is made durable before best-effort browser cleanup; wait
    // for the whole orchestration finally block before asserting teardown.
    await waitFor(() => closedSessions === 1);
    const completedWorkspace = workspaceService.get(workspaceId)!;
    expect(completedWorkspace.atlasAgentId).toBe(agent.id);
    expect(completedWorkspace.atlasRun).toMatchObject({
      status: 'completed',
      phase: 'published',
      surfaceCount: 1,
      entityCount: 1,
      verifiedSurfaceCount: 1,
      validationErrors: [],
    });
    expect(completedWorkspace.qaSurfaceVerifications).toEqual({ home: 100 });
    expect(await Bun.file(join(projectRoot, 'docs', 'ui-atlas', 'atlas.md')).text()).toContain('Integration');
    expect(await readdir(join(projectRoot, 'docs', '.agent-forge-atlas-candidates')).catch(() => [])).toEqual([]);
    expect(closedSessions).toBe(1);
  } finally {
    atlasTurnResult = null;
    browserService.closeContext = originalCloseContext;
  }
});
