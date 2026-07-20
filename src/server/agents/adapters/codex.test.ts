import { expect, test } from 'bun:test';
import type { AgentEvent } from '../events';
import type { AgentRunContext } from '../types';
import { buildCodexExecArgs, codexImageArgs, codexReasoningConfigArg, handleCodexEvent, resolveCodexCompletion } from './codex';

function makeContext(events: AgentEvent[]): AgentRunContext {
  return {
    paneId: 'test-agent',
    cwd: process.cwd(),
    getSessionId: () => null,
    updateSessionId: () => {},
    emitChatEvent: () => {},
    emitAgentEvent: (event) => { events.push(event); },
    emitStatus: () => {},
    emitActivity: () => {},
    emitSystemMessage: () => {},
  };
}

test('Codex reasoning choices become real CLI configuration overrides', () => {
  expect(codexReasoningConfigArg()).toBe('model_reasoning_effort="medium"');
  expect(codexReasoningConfigArg('extra_high')).toBe('model_reasoning_effort="xhigh"');
  expect(codexReasoningConfigArg('max')).toBe('model_reasoning_effort="max"');
  expect(codexReasoningConfigArg('ultra')).toBe('model_reasoning_effort="ultra"');
});

test('Codex attaches every image natively, including a 100-image batch', () => {
  const paths = Array.from({ length: 100 }, (_, index) => `C:\\chat-images\\${index + 1}.png`);
  const args = codexImageArgs(paths);

  expect(args).toHaveLength(200);
  expect(args.filter(arg => arg === '--image')).toHaveLength(100);
  expect(args.filter(arg => arg !== '--image')).toEqual(paths);

  const fresh = buildCodexExecArgs('codex', ['--json'], null, paths);
  expect(fresh.slice(0, 4)).toEqual(['codex', 'exec', '--json', '-']);
  expect(fresh.slice(4)).toEqual(args);

  const resumed = buildCodexExecArgs('codex', ['--json'], 'session-123', paths);
  expect(resumed.slice(0, 6)).toEqual(['codex', 'exec', 'resume', '--json', 'session-123', '-']);
  expect(resumed.slice(6)).toEqual(args);
});

test('Codex clean completion without a final answer becomes a visible incomplete result', () => {
  const resolution = resolveCodexCompletion('', 'Still checking the live UI.', false, true, 'gpt-5.6-sol');

  expect(resolution).toContain('completed without emitting a final response');
  expect(resolution).toContain('Still checking the live UI.');
  expect(resolution).toContain('incomplete result');
  expect(resolution).toEndWith('Model: Codex — gpt-5.6-sol');
});

test('Codex completion recovery preserves canonical finals and does not duplicate an emitted final', () => {
  expect(resolveCodexCompletion('Finished.', 'Progress.', false, true)).toBe('Finished.');
  expect(resolveCodexCompletion('Finished.', 'Finished.', true, true)).toBeNull();
  expect(resolveCodexCompletion('', 'Progress.', false, false)).toBeNull();
});

test('Codex current MCP item events produce visible tool activity', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = {
    outputPath: '',
    toolOpen: false,
    hasFinalAssistantMessage: false,
    lastAssistantMessage: '',
    currentToolId: null,
    fileSnapshots: new Map(),
    commandOutputs: new Map(),
  };

  handleCodexEvent(ctx, state, {
    type: 'item.started',
    item: {
      id: 'tool-1',
      type: 'mcp_tool_call',
      server: 'functions',
      tool: 'exec',
      arguments: '{"task":"inspect"}',
    },
  });
  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'tool-1', type: 'mcp_tool_call', server: 'functions', tool: 'exec' },
  });

  expect(events[0]).toMatchObject({
    type: 'tool-call-start',
    toolName: 'functions.exec',
    input: { task: 'inspect' },
  });
  expect(events[1]).toMatchObject({ type: 'tool-call-end' });
});

test('Codex fast custom-tool completion still emits activity when item.started is absent', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = {
    outputPath: '',
    toolOpen: false,
    hasFinalAssistantMessage: false,
    lastAssistantMessage: '',
    currentToolId: null,
    fileSnapshots: new Map(),
    commandOutputs: new Map(),
  };

  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'tool-2', type: 'custom_tool_call', name: 'exec', input: { task: 'verify' } },
  });

  expect(events.map(event => event.type)).toEqual(['tool-call-start', 'tool-call-end']);
});
