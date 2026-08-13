import { expect, test } from 'bun:test';
import type { AgentEvent } from '../events';
import type { AgentRunContext } from '../types';
import {
  createClaudeRunState,
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
