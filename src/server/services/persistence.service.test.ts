import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedData } from '../../shared/protocol';
import { atomicWriteFile } from './atomic-file';
import { createFakeProcessProbe } from '../platform/process-probe';
import {
  createPersistenceService,
  normalizePersistedData,
  PERSISTED_SCHEMA_VERSION,
} from './persistence.service';
import { createOwnershipSession, recordFromProbe } from './process-ownership';

const temporaryDirectories: string[] = [];

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-persistence-'));
  temporaryDirectories.push(directory);
  return directory;
}

function emptyData(): PersistedData {
  return {
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    agents: [],
    messages: [],
    sharedContext: '',
    documents: [],
    settings: {},
    workspaces: [],
    usageEvents: [],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })));
});

test('normalization isolates malformed records and repairs unsafe numeric state', () => {
  const normalized = normalizePersistedData({
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    agents: [
      {
        id: 'agent-1', name: 'Main', cwd: 'C:\\repo', referencePaths: ['C:\\one', 7],
        systemPrompt: null, workspaceId: null, createdAt: Number.NaN,
        contextTokens: Number.POSITIVE_INFINITY, totalCostUsd: -1,
      },
      { id: 'agent-1', name: 'Duplicate', cwd: 'C:\\repo' },
      null,
    ],
    messages: [
      { id: 'message-1', agentId: 'agent-1', role: 'user', content: 'ok', timestamp: 1 },
      { id: 'message-2', agentId: 'missing-agent', role: 'user', content: 'orphan', timestamp: 2 },
    ],
    sharedContext: 42,
    documents: [],
    settings: [],
    workspaces: [],
  });

  expect(normalized.data.agents).toHaveLength(1);
  expect(normalized.data.agents[0]?.referencePaths).toEqual(['C:\\one']);
  expect((normalized.data.agents[0] as any).contextTokens).toBeUndefined();
  expect((normalized.data.agents[0] as any).totalCostUsd).toBeUndefined();
  expect(normalized.data.messages.map(message => message.id)).toEqual(['message-1']);
  expect(normalized.data.sharedContext).toBe('');
  expect(normalized.data.settings).toEqual({});
  expect(normalized.issues.length).toBeGreaterThanOrEqual(5);
});

test('normalization deeply repairs hostile workspace, QA, Atlas, message, and settings state', () => {
  const normalized = normalizePersistedData({
    ...emptyData(),
    agents: [{
      id: 'agent-1',
      name: 'Agent',
      cwd: 'C:\\repo',
      referencePaths: [],
      systemPrompt: '',
      workspaceId: 'workspace-1',
      createdAt: 1,
    }],
    messages: [{
      id: 'message-1',
      agentId: 'agent-1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
      imageAttachments: [null, { path: 'C:\\image.png', name: 'image.png', mimeType: 'image/png', size: 4 }],
      injected: 'discard me',
    }],
    documents: [{ id: 'doc-1', title: 'Plan', content: 'text', status: 'hostile', createdAt: Number.NaN, updatedAt: 2 }],
    settings: { sidebarWidth: Number.POSITIVE_INFINITY, selectedAgentIds: [null, 'agent-1'], secret: 'discard me' },
    workspaces: [{
      id: 'workspace-1',
      name: 'Workspace',
      cwd: 'C:\\repo',
      sortOrder: Number.NaN,
      gridColumns: 0,
      gridRows: 999,
      selectedAgentIds: [null, '', 'agent-1'],
      lockedAgentIds: ['agent-1', 7],
      createdAt: Number.NEGATIVE_INFINITY,
      qaRuns: [null, {
        id: 'run-1',
        sourceAgentId: 'agent-1',
        prompt: 'test',
        status: 'running',
        browserSessionId: 'qa-run-1',
        createdAt: 1,
      }],
      atlasRun: {
        id: 'atlas-1',
        mode: 'build',
        status: 'paused',
        candidateRelPath: '../../outside',
        browserSessionId: 'atlas-1',
        createdAt: 1,
        startedAt: 1,
        lastActivityAt: 1,
      },
      qaSurfaceVerifications: { valid: 10, invalid: Number.NaN },
      injected: 'discard me',
    }],
  });

  const workspace: any = normalized.data.workspaces[0];
  expect(workspace).toMatchObject({
    cwd: 'C:\\repo',
    sortOrder: 0,
    gridColumns: 3,
    gridRows: 2,
    selectedAgentIds: ['', 'agent-1'],
    lockedAgentIds: ['agent-1'],
    createdAt: 0,
    qaSurfaceVerifications: { valid: 10 },
  });
  expect(workspace.qaRuns.map((run: any) => run.id)).toEqual(['run-1']);
  expect(workspace.atlasRun.candidateRelPath).toBe('docs/.agent-forge-atlas-candidates/atlas-1');
  expect(workspace.injected).toBeUndefined();
  expect((normalized.data.messages[0] as any).imageAttachments).toHaveLength(1);
  expect((normalized.data.messages[0] as any).injected).toBeUndefined();
  expect(normalized.data.documents[0]?.status).toBe('draft');
  expect((normalized.data.settings as any).secret).toBeUndefined();
  expect(normalized.issues.length).toBeGreaterThan(0);

  const repeated = normalizePersistedData(normalized.data);
  expect(repeated.issues).toEqual([]);
  expect(repeated.data).toEqual(normalized.data);
});

test('a failed data write rejects, leaves prior state intact, and does not poison retries', async () => {
  const directory = await fixtureDirectory();
  const dataFile = join(directory, 'data.json');
  const pidFile = join(directory, 'pids.json');
  await writeFile(dataFile, JSON.stringify({ generation: 1 }));
  let failNextDataWrite = true;
  const service = createPersistenceService({
    dataFile,
    pidFile,
    writeFile: async (path, content, options) => {
      if (path === dataFile && failNextDataWrite) {
        failNextDataWrite = false;
        throw new Error('injected disk failure');
      }
      await atomicWriteFile(path, content, options);
    },
  });
  service.setBuildPersistedData(() => ({ ...emptyData(), sharedContext: 'durable' }));

  await expect(service.saveNow()).rejects.toThrow('injected disk failure');
  expect(JSON.parse(await readFile(dataFile, 'utf8'))).toEqual({ generation: 1 });

  await service.saveNow();
  expect(JSON.parse(await readFile(dataFile, 'utf8')).sharedContext).toBe('durable');
});

test('queued writes persist the snapshot captured by their own saveNow call', async () => {
  const directory = await fixtureDirectory();
  const dataFile = join(directory, 'data.json');
  const pidFile = join(directory, 'pids.json');
  let state = 'first';
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
  const writes: string[] = [];
  const service = createPersistenceService({
    dataFile,
    pidFile,
    writeFile: async (_path, content) => {
      const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
      writes.push(JSON.parse(text).sharedContext);
      if (writes.length === 1) await firstMayFinish;
    },
  });
  service.setBuildPersistedData(() => ({ ...emptyData(), sharedContext: state }));

  const first = service.saveNow();
  state = 'second';
  const second = service.saveNow();
  state = 'uncommitted-later-state';
  releaseFirst();

  await Promise.all([first, second]);
  expect(writes).toEqual(['first', 'second']);
});

test('debounced saves cannot capture later state that never requested persistence', async () => {
  const directory = await fixtureDirectory();
  let state = 'requested';
  let persisted = '';
  const service = createPersistenceService({
    dataFile: join(directory, 'data.json'),
    pidFile: join(directory, 'pids.json'),
    debounceMs: 5,
    writeFile: async (_path, content) => {
      persisted = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    },
  });
  service.setBuildPersistedData(() => ({ ...emptyData(), sharedContext: state }));

  service.save();
  state = 'unannounced-and-rolled-back';
  await new Promise(resolve => setTimeout(resolve, 20));

  expect(JSON.parse(persisted).sharedContext).toBe('requested');
});

test('PID persistence errors propagate and a later write can recover', async () => {
  const directory = await fixtureDirectory();
  const dataFile = join(directory, 'data.json');
  const pidFile = join(directory, 'pids.json');
  let failNextPidWrite = true;
  const service = createPersistenceService({
    dataFile,
    pidFile,
    activePids: new Set([4242]),
    writeFile: async (path, content, options) => {
      if (path === pidFile && failNextPidWrite) {
        failNextPidWrite = false;
        throw new Error('PID disk full');
      }
      await atomicWriteFile(path, content, options);
    },
  });

  await expect(service.savePidsNow()).rejects.toThrow('PID disk full');
  await service.savePidsNow();
  expect(JSON.parse(await readFile(pidFile, 'utf8'))).toEqual([4242]);
});

test('orphan cleanup ignores unsafe records, never kills legacy PIDs, and durably clears the file', async () => {
  const directory = await fixtureDirectory();
  const dataFile = join(directory, 'missing-data.json');
  const pidFile = join(directory, 'pids.json');
  const ownedFile = join(directory, 'owned-processes.json');
  const candidates = Array.from({ length: 300 }, (_, index) => 10_000 + index);
  await writeFile(pidFile, JSON.stringify([process.pid, -1, 0, 1, 42, 42, 3.5, '44', ...candidates]));
  const liveLegacy = new Map([
    [42, { status: 'matched' as const, identity: { pid: 42, name: 'bun', startTimeMs: 1 } }],
    [10_000, { status: 'matched' as const, identity: { pid: 10_000, name: 'claude', startTimeMs: 2 } }],
  ]);
  const killed: number[] = [];
  const service = createPersistenceService({
    dataFile,
    pidFile,
    ownedFile,
    probe: createFakeProcessProbe(liveLegacy),
    killTree: async pid => {
      killed.push(pid);
      return { attempted: true, succeeded: true, exitCode: 0, timedOut: false };
    },
  });

  expect(await service.load()).toBeNull();
  expect(killed).toEqual([]);
  expect(JSON.parse(await readFile(pidFile, 'utf8'))).toEqual([]);
  expect(await Bun.file(ownedFile).exists()).toBe(false);
});

test('owned-process recovery terminates only a twice-proved V2 match', async () => {
  const directory = await fixtureDirectory();
  const ownedFile = join(directory, 'owned-processes.json');
  const session = createOwnershipSession('instance-a');
  const owned = recordFromProbe(session, 'claude', { pid: 4242, name: 'claude', startTimeMs: 1_700_000_000_000 });
  const reused = recordFromProbe(session, 'codex', { pid: 4343, name: 'codex', startTimeMs: 1_700_000_000_000 });
  await writeFile(ownedFile, JSON.stringify([owned, reused]));
  const killed: number[] = [];
  const service = createPersistenceService({
    dataFile: join(directory, 'missing-data.json'),
    pidFile: join(directory, 'pids.json'),
    ownedFile,
    probe: createFakeProcessProbe(new Map([
      [4242, { status: 'matched', identity: { pid: 4242, name: 'claude', startTimeMs: 1_700_000_000_100 } }],
      [4343, { status: 'matched', identity: { pid: 4343, name: 'bun', startTimeMs: 1_700_000_000_100 } }],
    ])),
    killTree: async pid => {
      killed.push(pid);
      return { attempted: true, succeeded: true, exitCode: 0, timedOut: false };
    },
  });

  expect(await service.load()).toBeNull();
  expect(killed).toEqual([4242]);
  expect(JSON.parse(await readFile(ownedFile, 'utf8'))).toEqual([]);
});

test('active PID snapshots cannot mutate the recovery registry', () => {
  const activePids = new Set<number>([4242]);
  const service = createPersistenceService({ activePids });
  service.getActivePids().clear();
  expect([...service.getActivePids()]).toEqual([4242]);
  service.trackPid(1);
  expect([...service.getActivePids()]).toEqual([4242]);
});

test('corrupt JSON is preserved instead of crashing startup', async () => {
  const directory = await fixtureDirectory();
  const dataFile = join(directory, 'data.json');
  await writeFile(dataFile, '{incomplete');
  const service = createPersistenceService({
    dataFile,
    pidFile: join(directory, 'pids.json'),
    ownedFile: join(directory, 'owned-processes.json'),
    now: () => 123,
  });

  expect(await service.load()).toBeNull();
  expect(await readdir(directory)).toEqual(['data.json.corrupt-123']);
  expect(await readFile(join(directory, 'data.json.corrupt-123'), 'utf8')).toBe('{incomplete');
});

test('legacy partial state is backed up and replaced by normalized versioned state', async () => {
  const directory = await fixtureDirectory();
  const dataFile = join(directory, 'data.json');
  const original = JSON.stringify({ agents: 'bad', messages: [], sharedContext: '', documents: [], settings: {}, workspaces: [] });
  await writeFile(dataFile, original);
  const service = createPersistenceService({
    dataFile,
    pidFile: join(directory, 'pids.json'),
    ownedFile: join(directory, 'owned-processes.json'),
    now: () => 456,
  });

  const loaded = await service.load();
  expect(loaded?.schemaVersion).toBe(PERSISTED_SCHEMA_VERSION);
  expect(loaded?.agents).toEqual([]);
  expect(await readFile(join(directory, 'data.json.recovery-456'), 'utf8')).toBe(original);
  expect(JSON.parse(await readFile(dataFile, 'utf8')).schemaVersion).toBe(PERSISTED_SCHEMA_VERSION);
});

test('a future schema is rejected while preserving both original and a safety copy', async () => {
  const directory = await fixtureDirectory();
  const dataFile = join(directory, 'data.json');
  const original = JSON.stringify({ ...emptyData(), schemaVersion: PERSISTED_SCHEMA_VERSION + 1 });
  await writeFile(dataFile, original);
  const service = createPersistenceService({
    dataFile,
    pidFile: join(directory, 'pids.json'),
    ownedFile: join(directory, 'owned-processes.json'),
    now: () => 789,
  });

  await expect(service.load()).rejects.toThrow('Unsupported Agent Forge data schema version');
  expect(await readFile(dataFile, 'utf8')).toBe(original);
  expect(await readFile(`${dataFile}.unsupported-789`, 'utf8')).toBe(original);
});

test('oversized persistence files are preserved without parsing or orphan execution', async () => {
  const directory = await fixtureDirectory();
  const dataFile = join(directory, 'data.json');
  const pidFile = join(directory, 'pids.json');
  await writeFile(dataFile, JSON.stringify({ ...emptyData(), sharedContext: 'x'.repeat(500) }));
  await writeFile(pidFile, JSON.stringify([12345, 23456]));
  const killed: number[] = [];
  const service = createPersistenceService({
    dataFile,
    pidFile,
    ownedFile: join(directory, 'owned-processes.json'),
    maxDataBytes: 100,
    maxPidBytes: 10,
    now: () => 999,
    killTree: async pid => {
      killed.push(pid);
      return { attempted: true, succeeded: true, exitCode: 0, timedOut: false };
    },
  });

  expect(await service.load()).toBeNull();
  expect(killed).toEqual([]);
  expect(await readFile(`${dataFile}.oversized-999`, 'utf8')).toContain('sharedContext');
  expect(await readFile(`${pidFile}.oversized-999`, 'utf8')).toContain('12345');
  expect(JSON.parse(await readFile(pidFile, 'utf8'))).toEqual([]);
});

test('oversized generated state rejects before replacing the durable file', async () => {
  const directory = await fixtureDirectory();
  const dataFile = join(directory, 'data.json');
  const original = JSON.stringify({ generation: 1 });
  await writeFile(dataFile, original);
  const service = createPersistenceService({
    dataFile,
    pidFile: join(directory, 'pids.json'),
    maxDataBytes: 100,
  });
  service.setBuildPersistedData(() => ({ ...emptyData(), sharedContext: 'x'.repeat(500) }));

  await expect(service.saveNow()).rejects.toThrow('data limit is 100 bytes');
  expect(await readFile(dataFile, 'utf8')).toBe(original);
});
