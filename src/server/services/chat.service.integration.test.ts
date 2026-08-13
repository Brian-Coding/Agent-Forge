import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { ServerMessage } from '../../shared/protocol';
import type { AgentAdapter, AgentHandle, AgentRunContext } from '../agents/types';
import { getAgentAdapter, registerAdapter, resolveAgentModel } from '../agents/registry';
import { clients } from '../broadcast';
import { agentService } from './agent.service';
import { chatService, MAX_PERSISTED_CHAT_CHARS } from './chat.service';
import { documentService } from './document.service';
import { liveTurnStateService } from './live-turn-state.service';
import { persistenceService } from './persistence.service';
import { usageService } from './usage.service';

const originalCodexAdapter = getAgentAdapter('codex')!;
const originalSave = persistenceService.save;
const originalSaveNow = persistenceService.saveNow;
const originalStartPlansWatcher = documentService.startPlansWatcher;
const originalStopPlansWatcher = documentService.stopPlansWatcher;
const originalReleaseLocks = documentService.releaseLocksForAgent;
const testAgentIds = new Set<string>();
const messages: ServerMessage[] = [];
const releases = new Map<string, number>();
let fixtureDirectory = '';
let saveNowFailure: Error | null = null;
let saveNowCalls = 0;

const fakeClient = {
  send(payload: string) {
    messages.push(JSON.parse(payload));
  },
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function registerTestAdapter(
  createHandle: (prompt: string, ctx: AgentRunContext, attempt: number) => AgentHandle,
): void {
  let attempt = 0;
  const adapter: AgentAdapter<Record<string, never>> = {
    kind: 'codex',
    displayName: 'Reliability Codex Double',
    createState() { return {}; },
    createHandle(prompt, ctx) { return createHandle(prompt, ctx, ++attempt); },
  };
  registerAdapter(adapter);
}

function loadAgent(options: {
  id?: string;
  sessionId?: string | null;
  sessionModel?: string | null;
} = {}): string {
  const id = options.id ?? `chat-${randomUUID()}`;
  const model = resolveAgentModel('codex')!;
  agentService.load({
    agents: [{
      id,
      name: `Chat ${id.slice(-6)}`,
      cwd: fixtureDirectory,
      referencePaths: [],
      systemPrompt: '',
      status: 'idle',
      createdAt: Date.now(),
      workspaceId: '',
      provider: 'codex',
      model,
      currentSessionId: options.sessionId ?? null,
      currentSessionProvider: options.sessionId ? 'codex' : null,
      currentSessionModel: options.sessionId ? (options.sessionModel ?? model) : null,
    }],
    messages: [],
    sharedContext: '',
  });
  testAgentIds.add(id);
  return id;
}

function agentMessages(id: string) {
  return agentService.getMessages(id);
}

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 'agent-forge-chat-'));
  clients.add(fakeClient as any);
  persistenceService.save = () => {};
  persistenceService.saveNow = async () => {
    saveNowCalls++;
    if (saveNowFailure) throw saveNowFailure;
  };
  documentService.startPlansWatcher = () => {};
  documentService.stopPlansWatcher = () => {};
  documentService.releaseLocksForAgent = async agentId => {
    releases.set(agentId, (releases.get(agentId) ?? 0) + 1);
  };
});

beforeEach(() => {
  messages.length = 0;
  releases.clear();
  saveNowCalls = 0;
  saveNowFailure = null;
  usageService.load([]);
  liveTurnStateService.resetForTests();
});

afterEach(async () => {
  saveNowFailure = null;
  registerAdapter(originalCodexAdapter);
  for (const id of [...testAgentIds]) {
    if (agentService.getAgent(id)) await agentService.removeAgent(id);
    testAgentIds.delete(id);
  }
  usageService.load([]);
});

afterAll(async () => {
  clients.delete(fakeClient as any);
  persistenceService.save = originalSave;
  persistenceService.saveNow = originalSaveNow;
  documentService.startPlansWatcher = originalStartPlansWatcher;
  documentService.stopPlansWatcher = originalStopPlansWatcher;
  documentService.releaseLocksForAgent = originalReleaseLocks;
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test('normal completion persists one result, one usage row, session ownership, and one cleanup', async () => {
  const id = loadAgent();
  const model = resolveAgentModel('codex')!;
  registerTestAdapter((_prompt, ctx) => ({
    async run() {
      ctx.updateSessionId('session-complete');
      ctx.emitAgentEvent({ type: 'status', status: 'thinking' });
      ctx.emitAgentEvent({
        type: 'usage',
        inputTokensDelta: 120,
        outputTokensDelta: 30,
        costUsdDelta: 0.25,
        turnsDelta: 1,
        modelRan: model,
      });
      ctx.emitAgentEvent({ type: 'usage', inputTokensDelta: Number.NaN, outputTokensDelta: Number.POSITIVE_INFINITY });
      ctx.emitAgentEvent({ type: 'result', text: 'Completed exactly once.', checkpoint: true });
      return undefined;
    },
    stop() {},
    kill() {},
  }));

  await chatService.sendMessage(id, 'Do the work.');

  expect(agentMessages(id).map(message => [message.role, message.content])).toEqual([
    ['user', 'Do the work.'],
    ['assistant', 'Completed exactly once.'],
  ]);
  expect(agentService.getAgent(id)).toMatchObject({
    status: 'idle',
    lastTurnOutcome: { status: 'completed' },
  });
  expect(agentService.getCurrentSessionId(id)).toBe('session-complete');
  expect(usageService.getEvents()).toHaveLength(1);
  expect(usageService.getEvents()[0]).toMatchObject({
    inputTokens: 120,
    outputTokens: 30,
    costUsd: 0.25,
    turns: 1,
  });
  expect(releases.get(id)).toBe(1);
  expect(liveTurnStateService.get(id)).toMatchObject({ active: false, phase: 'idle' });
});

test('provider failure becomes a durable failed outcome rather than a successful empty turn', async () => {
  const id = loadAgent();
  registerTestAdapter(() => ({
    async run() { throw new Error('provider transport exploded'); },
    stop() {},
    kill() {},
  }));

  await chatService.sendMessage(id, 'This must not disappear.');

  expect(agentMessages(id).map(message => message.role)).toEqual(['user', 'system']);
  expect(agentMessages(id)[1]?.content).toContain('Agent run failed: provider transport exploded');
  expect(agentService.getAgent(id)?.lastTurnOutcome).toMatchObject({
    status: 'failed',
    detail: 'provider transport exploded',
  });
  expect(releases.get(id)).toBe(1);
});

test('a clean stale session retries once with no duplicate user turn or partial output', async () => {
  const id = loadAgent({ sessionId: 'stale-session' });
  const sessionIds: Array<string | null> = [];
  registerTestAdapter((_prompt, ctx, attempt) => ({
    async run() {
      sessionIds.push(ctx.getSessionId());
      if (attempt === 1) {
        ctx.emitAgentEvent({ type: 'text-delta', text: 'discarded resume fragment' });
        return { recoverableError: 'stale-session' as const, errorMessage: 'not found' };
      }
      ctx.emitAgentEvent({ type: 'result', text: 'Fresh retry completed.', checkpoint: true });
    },
    stop() {},
    kill() {},
  }));

  await chatService.sendMessage(id, 'Resume safely.');

  expect(sessionIds).toEqual(['stale-session', null]);
  expect(agentMessages(id).filter(message => message.role === 'user')).toHaveLength(1);
  expect(agentMessages(id).filter(message => message.role === 'assistant').map(message => message.content))
    .toEqual(['Fresh retry completed.']);
  expect(agentService.getAgent(id)?.lastTurnOutcome?.status).toBe('completed');
});

test('stale-session recovery does not retry after a tool call could have mutated external state', async () => {
  const id = loadAgent({ sessionId: 'stale-session' });
  let attempts = 0;
  registerTestAdapter((_prompt, ctx) => ({
    async run() {
      attempts++;
      ctx.emitAgentEvent({
        type: 'tool-call-start',
        toolCallId: 'mutation-1',
        toolName: 'external_mutation',
        input: { target: 'record-1' },
      });
      return { recoverableError: 'stale-session' as const, errorMessage: 'stale after tool dispatch' };
    },
    stop() {},
    kill() {},
  }));

  await chatService.sendMessage(id, 'Do not duplicate this action.');

  expect(attempts).toBe(1);
  expect(agentMessages(id).filter(message => message.role === 'system').map(message => message.content))
    .toContain('Codex session recovery failed: stale after tool dispatch');
  expect(agentService.getAgent(id)?.lastTurnOutcome?.status).toBe('failed');
});

test('cancellation drops queued work and late adapter callbacks cannot mutate state', async () => {
  const id = loadAgent();
  const started = deferred<void>();
  const stopped = deferred<void>();
  let attempts = 0;
  let capturedContext: AgentRunContext | null = null;
  registerTestAdapter((_prompt, ctx) => {
    attempts++;
    capturedContext = ctx;
    return {
      async run() {
        ctx.emitAgentEvent({ type: 'assistant-snapshot', text: 'Safe partial progress.' });
        started.resolve();
        await stopped.promise;
        return undefined;
      },
      stop() { stopped.resolve(); },
      kill() { stopped.resolve(); },
    };
  });

  const first = chatService.sendMessage(id, 'first');
  await started.promise;
  const queued = chatService.sendMessage(id, 'must be cancelled');
  await agentService.stopAgent(id, 'user');
  await Promise.all([first, queued]);

  expect(attempts).toBe(1);
  expect(agentMessages(id).filter(message => message.role === 'user').map(message => message.content)).toEqual(['first']);
  expect(agentMessages(id).filter(message => message.role === 'assistant').map(message => message.content))
    .toEqual(['Safe partial progress.\n\n[Stopped by user]']);
  expect(agentService.getAgent(id)?.lastTurnOutcome?.status).toBe('stopped');

  const beforeMessages = agentMessages(id).length;
  const beforeUsage = agentService.getTokenUsage(id);
  capturedContext!.emitAgentEvent({ type: 'result', text: 'late mutation', checkpoint: true });
  capturedContext!.emitAgentEvent({ type: 'usage', inputTokensDelta: 999, turnsDelta: 1 });
  capturedContext!.updateSessionId('late-session');
  expect(agentMessages(id)).toHaveLength(beforeMessages);
  expect(agentService.getTokenUsage(id)).toEqual(beforeUsage);
  expect(agentService.getCurrentSessionId(id)).toBeNull();
});

test('different agents run concurrently without sharing state', async () => {
  const firstId = loadAgent();
  const secondId = loadAgent();
  const bothStarted = deferred<void>();
  const release = deferred<void>();
  let active = 0;
  let maxActive = 0;
  let starts = 0;
  registerTestAdapter((_prompt, ctx) => ({
    async run() {
      starts++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (starts === 2) bothStarted.resolve();
      await release.promise;
      ctx.emitAgentEvent({ type: 'result', text: `done-${ctx.paneId}`, checkpoint: true });
      active--;
      return undefined;
    },
    stop() { release.resolve(); },
    kill() { release.resolve(); },
  }));

  const first = chatService.sendMessage(firstId, 'one');
  const second = chatService.sendMessage(secondId, 'two');
  await bothStarted.promise;
  release.resolve();
  await Promise.all([first, second]);

  expect(maxActive).toBe(2);
  expect(agentMessages(firstId).at(-1)?.content).toBe(`done-${firstId}`);
  expect(agentMessages(secondId).at(-1)?.content).toBe(`done-${secondId}`);
  expect(releases.get(firstId)).toBe(1);
  expect(releases.get(secondId)).toBe(1);
});

test('huge provider output is persisted and broadcast with explicit bounds', async () => {
  const id = loadAgent();
  const huge = 'x'.repeat(MAX_PERSISTED_CHAT_CHARS + 250_000);
  registerTestAdapter((_prompt, ctx) => ({
    async run() {
      ctx.emitAgentEvent({ type: 'text-delta', text: huge });
      return undefined;
    },
    stop() {},
    kill() {},
  }));

  await chatService.sendMessage(id, 'large result');

  const assistant = agentMessages(id).find(message => message.role === 'assistant')!;
  expect(assistant.content).toHaveLength(MAX_PERSISTED_CHAT_CHARS);
  expect(assistant.content).toEndWith('[Output truncated by Agent Forge]');
  const frames = messages.filter((message): message is Extract<ServerMessage, { type: 'output' }> =>
    message.type === 'output' && message.agentId === id);
  expect(Math.max(...frames.map(frame => frame.content.length))).toBeLessThanOrEqual(64_000);
  expect(frames.reduce((sum, frame) => sum + frame.content.length, 0)).toBe(huge.length);
});

test('durability failure rejects the caller and the per-agent queue remains usable', async () => {
  const id = loadAgent();
  let attempts = 0;
  registerTestAdapter((_prompt, ctx) => ({
    async run() {
      attempts++;
      ctx.emitAgentEvent({ type: 'result', text: `result-${attempts}`, checkpoint: true });
      return undefined;
    },
    stop() {},
    kill() {},
  }));
  saveNowFailure = new Error('injected durable write failure');

  await expect(chatService.sendMessage(id, 'first')).rejects.toThrow('injected durable write failure');
  saveNowFailure = null;
  await chatService.sendMessage(id, 'second');

  expect(attempts).toBe(2);
  expect(agentMessages(id).filter(message => message.role === 'assistant').map(message => message.content))
    .toEqual(['result-1', 'result-2']);
  expect(saveNowCalls).toBeGreaterThanOrEqual(2);
});

test('removal waits for active teardown so late completion cannot recreate orphan messages', async () => {
  const id = loadAgent();
  const started = deferred<void>();
  const mayExit = deferred<void>();
  let stopCalls = 0;
  let killCalls = 0;
  registerTestAdapter((_prompt, ctx) => ({
    async run() {
      started.resolve();
      await mayExit.promise;
      // If removal deletes the agent first, these callbacks must be rejected
      // by the turn epoch and never repopulate its message bucket.
      ctx.emitAgentEvent({ type: 'result', text: 'late result after remove', checkpoint: true });
      return undefined;
    },
    stop() { stopCalls++; },
    kill() { killCalls++; mayExit.resolve(); },
  }));

  const send = chatService.sendMessage(id, 'remove while running');
  await started.promise;
  expect(await agentService.removeAgent(id)).toBe(true);
  await send;

  expect(killCalls).toBe(1);
  expect(stopCalls).toBe(0);
  expect(agentService.getAgent(id)).toBeUndefined();
  expect(agentMessages(id)).toEqual([]);
  testAgentIds.delete(id);
});

test('waitForAgentTurn returns false on a bounded stubborn handle and remains usable afterward', async () => {
  const id = loadAgent();
  const started = deferred<void>();
  const mayExit = deferred<void>();
  registerTestAdapter(() => ({
    async run() {
      started.resolve();
      await mayExit.promise;
      return undefined;
    },
    stop() {},
    kill() {},
  }));

  const send = chatService.sendMessage(id, 'stubborn');
  await started.promise;
  chatService.kill(id);
  expect(await chatService.waitForAgentTurn(id, 15)).toBe(false);
  expect(agentService.getAgent(id)?.id).toBe(id);

  mayExit.resolve();
  await send;
  expect(await chatService.waitForAgentTurn(id, 100)).toBe(true);
});
