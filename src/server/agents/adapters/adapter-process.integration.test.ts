import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../events';
import type { AgentRunContext } from '../types';
import { persistenceService } from '../../services/persistence.service';
import { claudeAdapter } from './claude';
import { codexAdapter } from './codex';

interface ContextFixture {
  ctx: AgentRunContext;
  events: AgentEvent[];
  chatEvents: unknown[];
  systemMessages: string[];
  getSession(): string | null;
}

let root = '';
let originalPath: string | undefined;
let originalSkipAuth: string | undefined;
let originalFakeProvider: string | undefined;
let originalCodexHome: string | undefined;
let originalTrackPid: typeof persistenceService.trackPid;
let originalUntrackPid: typeof persistenceService.untrackPid;
let originalBinaryCache: Map<string, string>;
const tracked: number[] = [];
const untracked: number[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function writeFakeCli(name: 'claude' | 'codex', scriptPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await Bun.write(join(root, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return;
  }
  const path = join(root, name);
  await Bun.write(path, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`);
  await chmod(path, 0o755);
}

function makeContext(provider: 'claude' | 'codex', sessionId: string | null = null): ContextFixture {
  process.env.AGENT_FORGE_FAKE_PROVIDER = provider;
  const events: AgentEvent[] = [];
  const chatEvents: unknown[] = [];
  const systemMessages: string[] = [];
  let session = sessionId;
  const ctx: AgentRunContext = {
    paneId: `${provider}-${randomUUID()}`,
    cwd: root,
    referencePaths: [],
    systemPrompt: 'Test guardrail context.',
    model: provider === 'claude' ? 'claude-opus-5' : 'gpt-5.6-sol',
    reasoningLevel: provider === 'codex' ? 'high' : undefined,
    getSessionId: () => session,
    updateSessionId: next => { session = next; },
    emitChatEvent: event => { chatEvents.push(event); },
    emitAgentEvent: event => { events.push(event); },
    emitStatus: () => {},
    emitActivity: () => {},
    emitSystemMessage: message => { systemMessages.push(message); },
  };
  return { ctx, events, chatEvents, systemMessages, getSession: () => session };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fake CLI event');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

beforeAll(async () => {
  root = join(tmpdir(), `agent forge fake cli ${randomUUID()}`);
  await mkdir(root, { recursive: true });
  await Bun.write(join(root, 'descendant.cjs'), `
const fs = require('node:fs');
const path = require('node:path');
const depth = Number(process.argv[2]);
fs.writeFileSync(path.join(__dirname, 'descendant-' + depth + '.pid'), String(process.pid));
if (depth === 1) require('node:child_process').spawn(process.execPath, [__filename, '2'], { stdio: 'inherit' });
setInterval(() => {}, 60000);
`);
  const scriptSource = `
const fs = require('node:fs');
const provider = process.env.AGENT_FORGE_FAKE_PROVIDER;
const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  if (prompt.includes('FINAL_FILE_')) {
    const outputIndex = args.indexOf('--output-last-message');
    fs.writeFileSync(args[outputIndex + 1], 'Codex final-file result.');
    emit({ type: 'thread.started', thread_id: 'codex-final-file-session' });
    if (prompt.includes('FINAL_FILE_HANG')) setInterval(() => {}, 60_000);
    else process.exitCode = prompt.includes('FINAL_FILE_NONZERO') ? 23 : 0;
    return;
  }
  if (prompt.includes('EXIT_WITH_DESCENDANTS')) {
    const path = require('node:path');
    const directory = process.cwd();
    require('node:child_process').spawn(process.execPath, [path.join(directory, 'descendant.cjs'), '1'], { stdio: 'inherit' });
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(directory, 'descendant-2.pid'))) return;
      clearInterval(timer);
      if (provider === 'claude') emit({ type: 'result', result: 'Descendants launched.' });
      else {
        const outputIndex = args.indexOf('--output-last-message');
        fs.writeFileSync(args[outputIndex + 1], 'Descendants launched.');
        emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Descendants launched.' } });
        emit({ type: 'turn.completed' });
      }
      process.exit(0);
    }, 10);
    return;
  }
  if (prompt.includes('GOAL_ABORT')) {
    const session = 'codex-goal-abort';
    const dir = require('node:path').join(process.env.CODEX_HOME, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(require('node:path').join(dir, 'rollout-test-' + session + '.jsonl'), [
      { type: 'event_msg', timestamp: '2026-09-12T06:29:08.468Z', payload: { type: 'task_complete', turn_id: 'repair' } },
      { type: 'event_msg', timestamp: '2026-09-12T06:29:08.784Z', payload: { type: 'task_started', turn_id: 'continuation' } },
      { type: 'event_msg', timestamp: '2026-09-12T06:29:08.991Z', payload: { type: 'turn_aborted', turn_id: 'continuation', reason: 'interrupted' } },
    ].map(event => JSON.stringify(event) + '\\n').join(''));
    emit({ type: 'thread.started', thread_id: session });
    emit({ type: 'turn.started' });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Repair published.' } });
    emit({ type: 'turn.completed' });
    emit({ type: 'turn.started' });
    setInterval(() => {}, 60_000);
    return;
  }
  if (prompt.includes('HANG')) {
    if (provider === 'claude') emit({ type: 'system', subtype: 'init', session_id: 'claude-hanging-session' });
    else emit({ type: 'thread.started', thread_id: 'codex-hanging-session' });
    setInterval(() => {}, 60_000);
    return;
  }

  if (prompt.includes('STALE')) {
    process.stderr.write('No conversation found with session ID stale-session\\n');
    process.exitCode = 17;
  } else if (prompt.includes('NONZERO')) {
    process.exitCode = 23;
  } else if (provider === 'claude') {
    emit({ type: 'system', subtype: 'init', session_id: 'claude-fake-session' });
    process.stdout.write('{malformed json line}\\n');
    emit({
      type: 'assistant',
      message: {
        id: 'message-1',
        model: 'claude-opus-5',
        usage: { input_tokens: 12, output_tokens: 4 },
        content: [{ type: 'text', text: 'Claude fake result.' }],
      },
    });
    emit({
      type: 'result',
      result: 'Claude fake result.',
      total_cost_usd: 0.01,
      num_turns: 1,
      modelUsage: { 'claude-opus-5': { inputTokens: 12, outputTokens: 4, contextWindow: 200000 } },
    });
    process.stderr.write('claude diagnostic\\n');
  } else {
    const outputIndex = args.indexOf('--output-last-message');
    if (outputIndex >= 0 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], 'Codex fake result.');
    emit({ type: 'thread.started', thread_id: 'codex-fake-session' });
    process.stdout.write('{malformed json line}\\n');
    emit({ type: 'turn.started' });
    emit({ type: 'item.started', item: { id: 'command-1', type: 'command_execution', command: 'echo ok' } });
    emit({ type: 'item.updated', item: { id: 'command-1', type: 'command_execution', aggregated_output: 'ok\\n' } });
    emit({ type: 'item.completed', item: { id: 'command-1', type: 'command_execution', aggregated_output: 'ok\\n' } });
    emit({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Codex fake result.' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5, reasoning_output_tokens: 2 } });
    process.stderr.write('codex diagnostic\\n');
  }
});
`;
  const claudePackageDir = join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  const codexPackageDir = join(root, 'node_modules', '@openai', 'codex', 'bin');
  await mkdir(claudePackageDir, { recursive: true });
  await mkdir(codexPackageDir, { recursive: true });
  const claudeScript = join(claudePackageDir, 'cli.js');
  const codexScript = join(codexPackageDir, 'codex.js');
  await Bun.write(claudeScript, scriptSource);
  await Bun.write(codexScript, scriptSource);
  await writeFakeCli('claude', claudeScript);
  await writeFakeCli('codex', codexScript);

  originalPath = process.env.PATH;
  originalSkipAuth = process.env.AGENT_FORGE_SKIP_CLAUDE_AUTH_CHECK;
  originalFakeProvider = process.env.AGENT_FORGE_FAKE_PROVIDER;
  originalCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, 'codex-home');
  process.env.PATH = `${root}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
  process.env.AGENT_FORGE_SKIP_CLAUDE_AUTH_CHECK = '1';
  originalBinaryCache = new Map((globalThis as any).__cliBinaryCache as Map<string, string>);
  const cache = (globalThis as any).__cliBinaryCache as Map<string, string>;
  // Pin fixtures so preferred user-local installations cannot run in this test.
  for (const provider of ['claude', 'codex']) {
    cache.set(provider, join(root, process.platform === 'win32' ? `${provider}.cmd` : provider));
  }

  originalTrackPid = persistenceService.trackPid;
  originalUntrackPid = persistenceService.untrackPid;
  persistenceService.trackPid = pid => { tracked.push(pid); };
  persistenceService.untrackPid = pid => { untracked.push(pid); };
});

beforeEach(() => {
  tracked.length = 0;
  untracked.length = 0;
});

afterAll(async () => {
  persistenceService.trackPid = originalTrackPid;
  persistenceService.untrackPid = originalUntrackPid;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalSkipAuth === undefined) delete process.env.AGENT_FORGE_SKIP_CLAUDE_AUTH_CHECK;
  else process.env.AGENT_FORGE_SKIP_CLAUDE_AUTH_CHECK = originalSkipAuth;
  if (originalFakeProvider === undefined) delete process.env.AGENT_FORGE_FAKE_PROVIDER;
  else process.env.AGENT_FORGE_FAKE_PROVIDER = originalFakeProvider;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  const cache = (globalThis as any).__cliBinaryCache as Map<string, string>;
  cache.clear();
  for (const [name, path] of originalBinaryCache) cache.set(name, path);
  await rm(root, { recursive: true, force: true });
});

test('Claude adapter exercises real stdin, malformed JSONL, stderr, result, exit, and PID cleanup', async () => {
  const fixture = makeContext('claude');
  const state = claudeAdapter.createState(fixture.ctx);
  const result = await claudeAdapter.createHandle('SUCCESS', fixture.ctx, state).run();

  expect({ result, events: fixture.events, systemMessages: fixture.systemMessages }).toMatchObject({
    result: { lastAssistantMessage: 'Claude fake result.' },
  });
  expect(fixture.getSession()).toBe('claude-fake-session');
  expect(fixture.events).toContainEqual({ type: 'finish', reason: 'completed' });
  expect(fixture.events.some(event => event.type === 'stderr' && event.text.includes('claude diagnostic'))).toBe(true);
  expect(fixture.chatEvents).toHaveLength(3);
  expect(tracked).toHaveLength(1);
  expect(untracked).toEqual(tracked);
});

test('both adapters surface nonzero empty output and classify stale resumed sessions without success', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const nonzero = makeContext(provider);
    const adapter = provider === 'claude' ? claudeAdapter : codexAdapter;
    const nonzeroResult = await adapter.createHandle('NONZERO', nonzero.ctx, adapter.createState(nonzero.ctx) as any).run();
    expect(nonzeroResult).toBeUndefined();
    expect(nonzero.events.some(event => event.type === 'error' && event.message.includes('23'))).toBe(true);
    expect(nonzero.events).toContainEqual({ type: 'finish', reason: 'exit:23' });

    const stale = makeContext(provider, 'stale-session');
    const staleResult = await adapter.createHandle('STALE', stale.ctx, adapter.createState(stale.ctx) as any).run();
    expect(staleResult).toMatchObject({ recoverableError: 'stale-session' });
    expect(stale.events).toContainEqual({ type: 'finish', reason: 'stale-session' });
    expect(stale.events.some(event => event.type === 'error')).toBe(false);
  }
});

test('Codex adapter exercises real tool streaming, final-file recovery, usage, and session ownership', async () => {
  const fixture = makeContext('codex');
  const state = codexAdapter.createState(fixture.ctx);
  const result = await codexAdapter.createHandle('SUCCESS', fixture.ctx, state).run();

  expect({ result, events: fixture.events, systemMessages: fixture.systemMessages }).toMatchObject({
    result: { lastAssistantMessage: 'Codex fake result.' },
  });
  expect(fixture.getSession()).toBe('codex-fake-session');
  expect(fixture.events.some(event => event.type === 'tool-call-start')).toBe(true);
  expect(fixture.events.some(event => event.type === 'tool-call-delta' && event.delta === 'ok\n')).toBe(true);
  expect(fixture.events.some(event => event.type === 'result' && event.text === 'Codex fake result.')).toBe(true);
  expect(fixture.events.some(event => event.type === 'usage' && event.turnsDelta === 1)).toBe(true);
  expect(fixture.events).toContainEqual({ type: 'finish', reason: 'completed' });
  expect(untracked).toEqual(tracked);
  expect(existsSync(state.outputPath)).toBe(false);
  expect(existsSync(state.outputDirectory)).toBe(false);
});

for (const outcome of ['SUCCESS', 'NONZERO', 'HANG'] as const) {
  test(`Codex removes final-message output with a temp-directory cwd after ${outcome}`, async () => {
    const originalCwd = process.cwd();
    const fixture = makeContext('codex');
    const state = codexAdapter.createState(fixture.ctx);
    const handle = codexAdapter.createHandle(`FINAL_FILE_${outcome}`, fixture.ctx, state);
    let run: ReturnType<typeof handle.run> | undefined;
    try {
      // Exercise the real protected-cwd check even when the test checkout is
      // outside the system temp directory. The fake provider writes only the
      // final-message file, so successful recovery proves it existed.
      process.chdir(root);
      run = handle.run();
      if (outcome === 'HANG') {
        await waitFor(() => fixture.getSession() === 'codex-final-file-session');
        expect(await readFile(state.outputPath, 'utf8')).toBe('Codex final-file result.');
        await handle.kill();
      }
      const result = await run;
      expect(fixture.events).toContainEqual({
        type: 'finish',
        reason: outcome === 'HANG' ? 'killed' : outcome === 'NONZERO' ? 'exit:23' : 'completed',
      });
      if (outcome === 'SUCCESS') {
        expect(result).toMatchObject({ lastAssistantMessage: 'Codex final-file result.' });
      }
      expect(existsSync(state.outputPath)).toBe(false);
      expect(existsSync(state.outputDirectory)).toBe(false);
      expect(untracked).toEqual(tracked);
    } finally {
      await handle.kill();
      await run;
      process.chdir(originalCwd);
      // Remove only this fixture's directory if a cleanup regression left it.
      await rm(state.outputDirectory, { recursive: true, force: true });
    }
  }, 10_000);
}

test('adapter cancellation terminates the real child and completes without an orphan', async () => {
  const fixture = makeContext('codex');
  const state = codexAdapter.createState(fixture.ctx);
  const handle = codexAdapter.createHandle('HANG', fixture.ctx, state);
  const run = handle.run();
  await waitFor(() => fixture.getSession() === 'codex-hanging-session');
  await handle.kill();
  await expect(run).resolves.toBeUndefined();

  expect(fixture.events).toContainEqual({ type: 'finish', reason: 'killed' });
  expect(tracked).toHaveLength(1);
  expect(untracked).toEqual(tracked);
}, 10_000);

test('a real CLI with an aborted goal continuation exposes stopped while retaining process ownership', async () => {
  const fixture = makeContext('codex');
  const state = codexAdapter.createState(fixture.ctx);
  const handle = codexAdapter.createHandle('GOAL_ABORT', fixture.ctx, state);
  let finished = false;
  const run = handle.run().finally(() => { finished = true; });
  try {
    await waitFor(() => fixture.events.some(e => e.type === 'provider-turn' && e.state.status === 'stopped'), 5000);
    expect(finished).toBe(false);
    expect(untracked).toHaveLength(0);
    expect(fixture.events.some(e => e.type === 'finish')).toBe(false);
    expect(fixture.events.filter(e => e.type === 'provider-turn' && e.state.source === 'rollout')
      .map(e => e.type === 'provider-turn' && e.state.status)).toEqual(['completed', 'running', 'stopped']);
  } finally {
    await handle.kill();
    await run;
  }
  expect(untracked).toEqual(tracked);
}, 10_000);

for (const provider of ['claude', 'codex'] as const) test.skipIf(process.platform === 'win32')(
  `${provider} cleans inherited pipes and descendants when the provider exits first`, async () => {
    for (const depth of [1, 2]) await rm(join(root, `descendant-${depth}.pid`), { force: true });
    const fixture = makeContext(provider);
    const adapter = provider === 'claude' ? claudeAdapter : codexAdapter;
    const handle = adapter.createHandle('EXIT_WITH_DESCENDANTS', fixture.ctx, adapter.createState(fixture.ctx) as any);
    const run = handle.run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([run, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Adapter waited on descendant-owned pipes')), 3000);
      })]);
      expect(result).toMatchObject({ lastAssistantMessage: 'Descendants launched.' });
      expect(fixture.events).toContainEqual({ type: 'finish', reason: 'completed' });
      for (const depth of [1, 2]) {
        const pid = Number(await readFile(join(root, `descendant-${depth}.pid`), 'utf8'));
        const probe = Bun.spawn(['ps', '-p', String(pid), '-o', 'stat='], { stdout: 'pipe' });
        const state = (await new Response(probe.stdout).text()).trim();
        await probe.exited;
        expect(state === '' || state.startsWith('Z')).toBe(true);
      }
      expect(untracked).toEqual(tracked);
    } finally {
      clearTimeout(timer);
      await handle.kill();
      await run;
    }
  }, 8000,
);
