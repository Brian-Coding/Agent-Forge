import { expect, test } from 'bun:test';
import type { AgentEvent } from '../events';
import type { AgentRunContext } from '../types';
import {
  createClaudeRunState,
  eventReportsExpiredAuth,
  isClaudeExpiredAuthText,
  normalizeClaudeEvent,
  resolveClaudeLaunchCommand,
  selectClaudeServingModel,
} from './claude';

function makeContext(events: AgentEvent[], systemMessages: string[] = []): AgentRunContext {
  return {
    paneId: 'test-agent',
    cwd: process.cwd(),
    model: 'claude-fable-5',
    getSessionId: () => null,
    updateSessionId: () => {},
    emitChatEvent: () => {},
    emitAgentEvent: event => events.push(event),
    emitStatus: () => {},
    emitActivity: () => {},
    emitSystemMessage: message => systemMessages.push(message),
  };
}

test('Claude partial thinking and text are not duplicated by the completed assistant snapshot', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = createClaudeRunState();
  const capture = () => {};

  normalizeClaudeEvent({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'msg-1' } },
  }, ctx, state, capture);
  normalizeClaudeEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Checking tests. ' } },
  }, ctx, state, capture);
  normalizeClaudeEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done.' } },
  }, ctx, state, capture);
  normalizeClaudeEvent({
    type: 'assistant',
    message: {
      model: 'claude-opus-5[1m]',
      content: [
        { type: 'thinking', thinking: 'Checking tests. ' },
        { type: 'text', text: 'Done.' },
      ],
    },
  }, ctx, state, capture);

  expect(events.filter(event => event.type === 'thinking-delta').map((event: any) => event.text)).toEqual([
    'Checking tests. ',
    '\n\n',
    'Done.',
  ]);
  expect(events.filter(event => event.type === 'text-delta')).toEqual([]);
  expect(events.filter(event => event.type === 'assistant-snapshot')).toEqual([
    { type: 'assistant-snapshot', text: 'Done.' },
  ]);
});

test('Claude serving-model selection ignores synthetic bookkeeping buckets', () => {
  expect(selectClaudeServingModel({
    '<synthetic>': { inputTokens: 100_000, outputTokens: 100_000, contextWindow: 1 },
    'claude-opus-5[1m]': { inputTokens: 1_000, outputTokens: 500, contextWindow: 1_000_000 },
  })).toEqual({ modelRan: 'claude-opus-5[1m]', contextLimit: 1_000_000 });

  expect(selectClaudeServingModel({ '<synthetic>': { inputTokens: 100 } })).toEqual({});
});

test('Claude bypasses a Windows npm cmd shim through its JavaScript entry point', () => {
  const shim = 'C:\\Program Files\\Agent Forge\\claude.cmd';
  const entry = 'C:\\Program Files\\Agent Forge\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  expect(resolveClaudeLaunchCommand(shim, 'win32', path => path === entry, 'C:\\node.exe'))
    .toEqual(['C:\\node.exe', entry]);
  expect(resolveClaudeLaunchCommand(shim, 'win32', () => false, 'C:\\node.exe')).toEqual([shim]);
  expect(resolveClaudeLaunchCommand('/usr/local/bin/claude', 'linux', () => true, '/usr/bin/node'))
    .toEqual(['/usr/local/bin/claude']);
});

test('oversized goal validation is an error and cannot claim a synthetic model', () => {
  const events: AgentEvent[] = [];
  const systemMessages: string[] = [];
  let claimedSession: string | null = null;
  const ctx = {
    ...makeContext(events, systemMessages),
    getSessionId: () => claimedSession,
    updateSessionId: (sessionId: string) => { claimedSession = sessionId; },
  };
  let captured = '';
  const state = createClaudeRunState();

  normalizeClaudeEvent({ type: 'system', subtype: 'init', session_id: 'synthetic-session' }, ctx, state, text => { captured = text; });

  normalizeClaudeEvent({
    type: 'result',
    result: 'Goal condition is limited to 4000 characters (got 14290)',
    modelUsage: { '<synthetic>': { inputTokens: 99_999 } },
  }, ctx, state, text => { captured = text; });

  expect(events.some(event => event.type === 'error')).toBe(true);
  expect(events.some(event => event.type === 'result')).toBe(false);
  expect(events.filter(event => event.type === 'usage')).toEqual([]);
  expect(systemMessages).toEqual([]);
  expect(captured).toBe('');
  expect(claimedSession).toBeNull();
  expect(events.some(event => event.type === 'session')).toBe(false);
});

test('a real assistant response claims the pending Claude session exactly once', () => {
  const events: AgentEvent[] = [];
  const claimedSessions: string[] = [];
  const ctx = {
    ...makeContext(events),
    getSessionId: () => claimedSessions.at(-1) ?? null,
    updateSessionId: (sessionId: string) => { claimedSessions.push(sessionId); },
  };
  const state = createClaudeRunState();

  normalizeClaudeEvent({ type: 'system', subtype: 'init', session_id: 'real-session' }, ctx, state, () => {});
  normalizeClaudeEvent({
    type: 'assistant',
    message: {
      id: 'message-1',
      model: 'claude-opus-5[1m]',
      content: [{ type: 'text', text: 'Working on it.' }],
    },
  }, ctx, state, () => {});
  normalizeClaudeEvent({
    type: 'result',
    result: 'Working on it.',
    modelUsage: { 'claude-opus-5[1m]': { inputTokens: 10, outputTokens: 4 } },
  }, ctx, state, () => {});

  expect(claimedSessions).toEqual(['real-session']);
  expect(events.filter(event => event.type === 'session')).toEqual([
    { type: 'session', providerSessionId: 'real-session' },
  ]);
});

// Expired-OAuth detection. The CLI reports a dead access token as an assistant
// text block on stdout and exits 1 with an empty stderr, so this text is the
// only evidence that the turn is retryable rather than genuinely broken.

test('isClaudeExpiredAuthText matches the CLI expired-token report', () => {
  expect(isClaudeExpiredAuthText(
    'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
  )).toBe(true);
  expect(isClaudeExpiredAuthText('API Error: 401 {"type":"error"} — please re-authenticate')).toBe(true);
});

test('isClaudeExpiredAuthText ignores unrelated failures', () => {
  expect(isClaudeExpiredAuthText('')).toBe(false);
  expect(isClaudeExpiredAuthText(null)).toBe(false);
  expect(isClaudeExpiredAuthText('API Error: 429 rate limit exceeded')).toBe(false);
  expect(isClaudeExpiredAuthText('No conversation found with session ID abc')).toBe(false);
  // A 401 that is not an expiry still needs a real login, not a silent retry.
  expect(isClaudeExpiredAuthText('API Error: 401 invalid api key')).toBe(false);
});

test('eventReportsExpiredAuth finds the report in an assistant text block', () => {
  expect(eventReportsExpiredAuth({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Failed to authenticate. API Error: 401 OAuth access token has expired.' },
      ],
    },
  })).toBe(true);
});

test('eventReportsExpiredAuth finds the report on result and error events', () => {
  expect(eventReportsExpiredAuth({
    type: 'result',
    is_error: true,
    result: '401 OAuth access token has expired. Re-authenticate to continue.',
  })).toBe(true);
  expect(eventReportsExpiredAuth({
    type: 'error',
    message: 'OAuth access token has expired',
  })).toBe(true);
});

test('eventReportsExpiredAuth ignores ordinary traffic', () => {
  expect(eventReportsExpiredAuth(null)).toBe(false);
  expect(eventReportsExpiredAuth({ type: 'system', subtype: 'init', session_id: 'abc' })).toBe(false);
  expect(eventReportsExpiredAuth({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Done — the token bucket refills hourly.' }] },
  })).toBe(false);
});

test('Claude result usage reconciles streamed tokens and supports result-only zero cost', () => {
  for (const streamed of [false, true]) {
    const events: AgentEvent[] = [];
    const ctx = makeContext(events);
    const state = createClaudeRunState();
    if (streamed) normalizeClaudeEvent({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 2 }, content: [] } }, ctx, state, () => {});
    normalizeClaudeEvent({ type: 'result', result: 'Done', usage: { input_tokens: 10, cache_read_input_tokens: 4, output_tokens: 3 }, total_cost_usd: 0 }, ctx, state, () => {});
    const usage = events.filter(event => event.type === 'usage');
    expect(usage.reduce((n, e) => n + (e.inputTokensDelta ?? 0), 0)).toBe(14);
    expect(usage.reduce((n, e) => n + (e.outputTokensDelta ?? 0), 0)).toBe(3);
    expect(usage.at(-1)?.costUsdDelta).toBe(0);
  }
});
