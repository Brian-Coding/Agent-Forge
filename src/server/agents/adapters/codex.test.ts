import { expect, test } from 'bun:test';
import type { AgentEvent } from '../events';
import type { AgentRunContext } from '../types';
import {
  observeTurnOutputEvent,
  resolveTurnFinalization,
} from '../../services/chat-turn-lifecycle';
import {
  buildCodexExecArgs,
  codexImageArgs,
  codexReasoningConfigArg,
  handleCodexEvent,
  parseCodexTransportStatus,
  resolveCodexCompletion,
  resolveCodexLaunchCommand,
} from './codex';

function makeContext(events: AgentEvent[], onEvent?: (event: AgentEvent) => void): AgentRunContext {
  return {
    paneId: 'test-agent',
    cwd: process.cwd(),
    getSessionId: () => null,
    updateSessionId: () => {},
    emitChatEvent: () => {},
    emitAgentEvent: (event) => {
      events.push(event);
      onEvent?.(event);
    },
    emitStatus: () => {},
    emitActivity: () => {},
    emitSystemMessage: () => {},
  };
}

function makeState() {
  return {
    outputPath: '',
    toolOpen: false,
    hasFinalAssistantMessage: false,
    lastAssistantMessage: '',
    pendingTurnAssistantMessage: '',
    lastCheckpointedMessage: '',
    currentTurnCheckpointed: false,
    transportRetryActive: false,
    lastTerminalErrorMessage: '',
    currentToolId: null,
    fileSnapshots: new Map<string, string | null>(),
    commandOutputs: new Map<string, string>(),
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

test('Codex bypasses the Windows cmd shim for a 100-image command line', () => {
  const shim = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const entrypoint = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js';
  const command = resolveCodexLaunchCommand(shim, 'win32', path => path === entrypoint, node);
  const paths = Array.from(
    { length: 100 },
    (_, index) => `C:\\Users\\tester\\AppData\\Local\\AgentForge\\artifacts\\chat-images\\agent-id\\1784568160143-${String(index).padStart(8, '0')}.png`,
  );
  const args = buildCodexExecArgs(command, ['--json'], null, paths);

  expect(command).toEqual([node, entrypoint]);
  expect(args[0]).toBe(node);
  expect(args[1]).toBe(entrypoint);
  expect(args).not.toContain(shim);
  expect(args.filter(arg => arg === '--image')).toHaveLength(100);
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
  expect(resolveCodexCompletion(
    'New continuation final.',
    'New continuation final.',
    true,
    true,
    undefined,
    'Earlier checkpoint.',
  )).toBe('New continuation final.');
  expect(resolveCodexCompletion('', 'Progress.', false, false)).toBeNull();
});

test('Codex current MCP item events produce visible tool activity', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = makeState();

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
  const state = makeState();

  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'tool-2', type: 'custom_tool_call', name: 'exec', input: { task: 'verify' } },
  });

  expect(events.map(event => event.type)).toEqual(['tool-call-start', 'tool-call-end']);
});

test('Codex 0.145 todo-list events keep goal activity visible', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = makeState();

  handleCodexEvent(ctx, state, {
    type: 'item.started',
    item: { id: 'goal-1', type: 'todo_list', items: [{ text: 'Verify lifecycle' }] },
  });
  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'goal-1', type: 'todo_list', items: [{ text: 'Verify lifecycle', completed: true }] },
  });

  expect(events[0]).toMatchObject({
    type: 'tool-call-start',
    toolName: 'UpdateGoal',
  });
  expect(events[1]).toMatchObject({ type: 'tool-call-end' });
});

test('each Codex turn.completed checkpoint survives a long-lived goal process', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = makeState();

  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'message-1', type: 'agent_message', text: 'Round one complete.' },
  });
  handleCodexEvent(ctx, state, {
    type: 'turn.completed',
    usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5 },
  });
  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'message-2', type: 'agent_message', text: 'Goal complete.' },
  });
  handleCodexEvent(ctx, state, {
    type: 'turn.completed',
    usage: { input_tokens: 120, output_tokens: 30, reasoning_output_tokens: 10 },
  });

  const checkpoints = events.filter(
    (event): event is Extract<AgentEvent, { type: 'result' }> => event.type === 'result',
  );
  expect(checkpoints).toEqual([
    { type: 'result', text: 'Round one complete.', checkpoint: true },
    { type: 'result', text: 'Goal complete.', checkpoint: true },
  ]);
  expect(state.lastCheckpointedMessage).toBe('Goal complete.');
  expect(state.pendingTurnAssistantMessage).toBe('');
});

test('identical answers in distinct goal turns are each checkpointed once', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = makeState();

  for (let turn = 0; turn < 2; turn++) {
    handleCodexEvent(ctx, state, { type: 'turn.started' });
    handleCodexEvent(ctx, state, {
      type: 'item.completed',
      item: { id: `message-${turn}`, type: 'agent_message', text: 'No issues found.' },
    });
    handleCodexEvent(ctx, state, { type: 'turn.completed' });
    // A duplicate boundary from the same provider turn must remain harmless.
    handleCodexEvent(ctx, state, { type: 'turn.completed' });
  }

  expect(events.filter(event => event.type === 'result')).toEqual([
    { type: 'result', text: 'No issues found.', checkpoint: true },
    { type: 'result', text: 'No issues found.', checkpoint: true },
  ]);
});

test('legacy task_complete boundaries persist each distinct goal result once', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = makeState();

  handleCodexEvent(ctx, state, {
    type: 'task_complete',
    last_agent_message: 'First legacy goal result.',
  });
  handleCodexEvent(ctx, state, {
    type: 'task_complete',
    last_agent_message: 'Second legacy goal result.',
  });
  handleCodexEvent(ctx, state, {
    type: 'task_complete',
    last_agent_message: 'Second legacy goal result.',
  });

  expect(events.filter(event => event.type === 'result')).toEqual([
    { type: 'result', text: 'First legacy goal result.', checkpoint: true },
    { type: 'result', text: 'Second legacy goal result.', checkpoint: true },
  ]);
});

test('only complete agent messages become interruption-safe snapshots', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = makeState();

  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'reasoning-1', type: 'reasoning', text: 'Private working notes.' },
  });
  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'message-1', type: 'agent_message', text: 'Safe partial answer.' },
  });

  expect(events.filter(event => event.type === 'assistant-snapshot')).toEqual([
    { type: 'assistant-snapshot', text: 'Safe partial answer.' },
  ]);
});

test('Codex turn.failed becomes a normalized durable error candidate', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = makeState();

  handleCodexEvent(ctx, state, {
    type: 'turn.failed',
    error: { message: 'Goal continuation failed.' },
  });

  expect(events).toContainEqual({
    type: 'error',
    message: 'Goal continuation failed.',
  });
});

test('Codex reconnect progress is classified narrowly as recoverable transport status', () => {
  const screenshotMessage = 'Reconnecting... 3/5 (stream disconnected before completion: websocket closed by server before response.completed)';

  expect(parseCodexTransportStatus(screenshotMessage)).toEqual({
    status: 'retrying',
    message: screenshotMessage,
    attempt: 3,
    maxAttempts: 5,
  });
  expect(parseCodexTransportStatus(
    'Falling back from WebSockets to HTTPS transport. stream disconnected before completion',
  )).toEqual({
    status: 'fallback',
    message: 'Falling back from WebSockets to HTTPS transport. stream disconnected before completion',
  });
  expect(parseCodexTransportStatus(
    'stream disconnected before completion: websocket closed by server before response.completed',
  )).toBeNull();
});

test('a recovered Codex reconnect stays pane-local and never becomes a terminal error', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = makeState();
  const screenshotMessage = 'Reconnecting... 3/5 (stream disconnected before completion: websocket closed by server before response.completed)';

  handleCodexEvent(ctx, state, { type: 'error', message: screenshotMessage });
  handleCodexEvent(ctx, state, { type: 'turn.started' });

  expect(events).toEqual([
    {
      type: 'transport-status',
      status: 'retrying',
      message: screenshotMessage,
      attempt: 3,
      maxAttempts: 5,
    },
    { type: 'transport-status', status: 'recovered' },
    { type: 'status', status: 'thinking' },
  ]);
  expect(events.some(event => event.type === 'error')).toBe(false);
});

test('Codex WebSocket fallback remains recoverable but a final failure is emitted once', () => {
  const events: AgentEvent[] = [];
  const ctx = makeContext(events);
  const state = makeState();
  const fallbackMessage = 'Falling back from WebSockets to HTTPS transport. stream disconnected before completion: socket closed';
  const terminalMessage = 'stream disconnected before completion: error sending request';

  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { type: 'error', message: fallbackMessage },
  });
  handleCodexEvent(ctx, state, { type: 'error', message: terminalMessage });
  handleCodexEvent(ctx, state, { type: 'turn.failed', error: { message: terminalMessage } });

  expect(events.filter(event => event.type === 'transport-status')).toEqual([
    { type: 'transport-status', status: 'fallback', message: fallbackMessage },
  ]);
  expect(events.filter(event => event.type === 'error')).toEqual([
    { type: 'error', message: terminalMessage },
  ]);
});

test('Codex goal events survive the adapter-to-chat lifecycle without duplicate finals', () => {
  const events: AgentEvent[] = [];
  const persisted: string[] = [];
  const outputState = {
    lastResultEmitted: null as string | null,
    lastAssistantSnapshot: null as string | null,
    lastErrorMessage: null as string | null,
  };
  const ctx = makeContext(events, event => {
    if (event.type !== 'assistant-snapshot' && event.type !== 'result' && event.type !== 'error') return;
    const observation = observeTurnOutputEvent(outputState, event);
    if (observation.checkpointText) persisted.push(observation.checkpointText);
  });
  const state = makeState();

  handleCodexEvent(ctx, state, { type: 'turn.started' });
  handleCodexEvent(ctx, state, {
    type: 'error',
    message: 'temporary stream retry',
  });
  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'message-1', type: 'agent_message', text: 'First round complete.' },
  });
  handleCodexEvent(ctx, state, { type: 'turn.completed' });
  handleCodexEvent(ctx, state, { type: 'turn.started' });
  handleCodexEvent(ctx, state, {
    type: 'item.completed',
    item: { id: 'message-2', type: 'agent_message', text: 'Goal fully complete.' },
  });
  handleCodexEvent(ctx, state, { type: 'turn.completed' });

  expect(persisted).toEqual(['First round complete.', 'Goal fully complete.']);
  expect(outputState.lastErrorMessage).toBeNull();
  expect(resolveTurnFinalization({
    provider: 'codex',
    accumulatedText: '',
    lastResultEmitted: outputState.lastResultEmitted,
    lastAssistantSnapshot: outputState.lastAssistantSnapshot,
    lastPersistedResult: persisted.at(-1) ?? null,
    errorMessage: outputState.lastErrorMessage,
  })).toEqual({
    assistantText: null,
    systemText: null,
  });
});
