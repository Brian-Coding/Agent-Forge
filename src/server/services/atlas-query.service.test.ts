import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceInfo } from '../../shared/protocol';
import { agentService } from './agent.service';
import { ATLAS_ANSWER_END, ATLAS_ANSWER_START, AtlasAnswerValidationError } from './atlas-query-result';
import { AtlasQueryBusyError, atlasQueryService } from './atlas-query.service';
import { documentService } from './document.service';
import { persistenceService } from './persistence.service';

const workspaceMap: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap;
const originalSendMessage = agentService.sendMessage;
const originalStopAgent = agentService.stopAgent;
const originalSave = persistenceService.save;
const originalSaveNow = persistenceService.saveNow;
const originalStartPlansWatcher = documentService.startPlansWatcher;
const originalStopPlansWatcher = documentService.stopPlansWatcher;
const originalReleaseLocks = documentService.releaseLocksForAgent;
const originalArtifactRoot = process.env.AGENT_FORGE_ARTIFACT_ROOT;
const workspaceIds = new Set<string>();
const directories = new Set<string>();
let sendHandler: ((agentId: string, content: string) => Promise<void>) | null = null;

function answer(citation = 'surface.home'): string {
  return `${ATLAS_ANSWER_START}\n${JSON.stringify({
    answer: `The requested view is \`${citation}\`.`,
    citations: [citation],
  })}\n${ATLAS_ANSWER_END}`;
}

async function makePublishedWorkspace(): Promise<string> {
  const workspaceId = `atlas-query-${randomUUID()}`;
  const root = await mkdtemp(join(tmpdir(), 'agent-forge-atlas-query-'));
  workspaceIds.add(workspaceId);
  directories.add(root);
  const atlasRoot = join(root, 'docs', 'ui-atlas');
  await mkdir(atlasRoot, { recursive: true });
  await writeFile(join(atlasRoot, 'atlas.json'), JSON.stringify({
    surfaces: [{ id: 'surface.home' }],
    entities: [{ id: 'entity.user' }],
    flows: [{ id: 'flow.open-home' }],
  }));
  workspaceMap.set(workspaceId, {
    id: workspaceId,
    name: 'Atlas Query Reliability',
    sortOrder: 0,
    gridColumns: 1,
    gridRows: 1,
    selectedAgentIds: [],
    lockedAgentIds: [],
    createdAt: Date.now(),
    atlasProjectCwd: root,
    atlasLastScanAt: Date.now(),
  });
  return workspaceId;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Atlas query state');
    await Bun.sleep(5);
  }
}

beforeAll(async () => {
  const artifacts = await mkdtemp(join(tmpdir(), 'agent-forge-atlas-query-artifacts-'));
  directories.add(artifacts);
  process.env.AGENT_FORGE_ARTIFACT_ROOT = artifacts;
  persistenceService.save = () => {};
  persistenceService.saveNow = async () => {};
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async () => {};
  agentService.sendMessage = async (agentId, content) => {
    if (!sendHandler) throw new Error('No Atlas query response fixture installed');
    await sendHandler(agentId, content);
  };
});

afterEach(async () => {
  sendHandler = null;
  agentService.stopAgent = originalStopAgent;
  for (const workspaceId of [...workspaceIds]) {
    for (const agent of agentService.getAgents().filter(candidate => candidate.workspaceId === workspaceId)) {
      await agentService.removeAgent(agent.id).catch(() => false);
    }
    workspaceMap.delete(workspaceId);
    workspaceIds.delete(workspaceId);
  }
});

afterAll(async () => {
  agentService.sendMessage = originalSendMessage;
  agentService.stopAgent = originalStopAgent;
  persistenceService.save = originalSave;
  persistenceService.saveNow = originalSaveNow;
  documentService.startPlansWatcher = originalStartPlansWatcher;
  documentService.stopPlansWatcher = originalStopPlansWatcher;
  documentService.releaseLocksForAgent = originalReleaseLocks;
  if (originalArtifactRoot === undefined) delete process.env.AGENT_FORGE_ARTIFACT_ROOT;
  else process.env.AGENT_FORGE_ARTIFACT_ROOT = originalArtifactRoot;
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

test('Ask Atlas uses an isolated read-only specialist, validates graph IDs, and always removes it', async () => {
  const workspaceId = await makePublishedWorkspace();
  let analystId = '';
  sendHandler = async (agentId, content) => {
    analystId = agentId;
    expect(content).toContain('<atlas_question>');
    expect(content).toContain('Where is Home?');
    const analyst = agentService.getAgent(agentId)!;
    expect(analyst).toMatchObject({
      name: 'Atlas Analyst',
      hideFromGrid: true,
      provider: 'codex',
      model: 'gpt-5.6-sol',
      reasoningLevel: 'xhigh',
    });
    agentService.appendMessage(agentId, 'assistant', answer());
  };

  const result = await atlasQueryService.ask(workspaceId, '  Where is Home?  ');

  expect(result).toMatchObject({
    citations: ['surface.home'],
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoningLevel: 'xhigh',
  });
  expect(agentService.getAgent(analystId)).toBeUndefined();
  expect(agentService.getMessages(analystId)).toEqual([]);
});

test('same-workspace Atlas queries are single-flight and a validation failure releases the lock', async () => {
  const workspaceId = await makePublishedWorkspace();
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  sendHandler = async (agentId) => {
    entered = true;
    await gate;
    agentService.appendMessage(agentId, 'assistant', answer('surface.invented'));
  };

  const first = atlasQueryService.ask(workspaceId, 'First question');
  await waitFor(() => entered);
  await expect(atlasQueryService.ask(workspaceId, 'Second question')).rejects.toBeInstanceOf(AtlasQueryBusyError);
  release();
  await expect(first).rejects.toBeInstanceOf(AtlasAnswerValidationError);

  sendHandler = async agentId => { agentService.appendMessage(agentId, 'assistant', answer()); };
  await expect(atlasQueryService.ask(workspaceId, 'Retry after failure')).resolves.toMatchObject({
    citations: ['surface.home'],
  });
});

test('a timed-out Atlas query requests cancellation, tears down its analyst, and permits a retry', async () => {
  const workspaceId = await makePublishedWorkspace();
  let timedOutAnalyst = '';
  let stopCalls = 0;
  sendHandler = async agentId => {
    timedOutAnalyst = agentId;
    await new Promise<void>(() => {});
  };
  agentService.stopAgent = async agentId => {
    expect(agentId).toBe(timedOutAnalyst);
    stopCalls++;
    return true;
  };

  await expect(atlasQueryService.ask(workspaceId, 'Question that hangs', { timeoutMs: 20 }))
    .rejects.toThrow('timed out after 20ms');
  expect(stopCalls).toBe(1);
  expect(agentService.getAgent(timedOutAnalyst)).toBeUndefined();

  agentService.stopAgent = originalStopAgent;
  sendHandler = async agentId => { agentService.appendMessage(agentId, 'assistant', answer()); };
  await expect(atlasQueryService.ask(workspaceId, 'Question after timeout')).resolves.toMatchObject({
    citations: ['surface.home'],
  });
});
