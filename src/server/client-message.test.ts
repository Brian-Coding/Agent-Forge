import { expect, test } from 'bun:test';
import type { ClientMessage } from '../shared/protocol';
import {
  ClientMessageValidationError,
  parseClientMessage,
  validateClientMessage,
} from './client-message';

const validMessages: ClientMessage[] = [
  { type: 'create_agent', name: 'A', cwd: 'C:\\work', referencePaths: ['C:\\ref'], systemPrompt: 'help', workspaceId: 'w1' },
  { type: 'update_agent', id: 'a1', name: 'B', cwd: '/work', referencePaths: ['/ref'], systemPrompt: '', provider: 'codex', model: 'gpt', reasoningLevel: 'high' },
  { type: 'resolve_model_mismatch', id: 'a1', action: 'continue-actual' },
  { type: 'send_message', agentId: 'a1', content: '' },
  { type: 'kill_agent', agentId: 'a1' },
  { type: 'stop_agent', agentId: 'a1' },
  { type: 'remove_agent', agentId: 'a1' },
  { type: 'clear_history', agentId: 'a1' },
  { type: 'update_shared_context', content: '' },
  { type: 'get_shared_context' },
  { type: 'list_agents' },
  { type: 'get_history', agentId: 'a1' },
  { type: 'get_settings' },
  { type: 'update_settings', settings: { activeWorkspaceId: 'w1', sidebarWidth: 240, gridColumns: 3, gridRows: 2, selectedAgentIds: ['a1', '', ''] } },
  { type: 'send_image', agentId: 'a1', imageData: 'AAAA', mimeType: 'image/png', prompt: '' },
  { type: 'send_images', agentId: 'a1', images: [{ imageData: 'AAAA', mimeType: 'image/png' }] },
  { type: 'send_uploaded_images', agentId: 'a1', images: [{ path: 'C:\\images\\a.png', name: 'a.png', mimeType: 'image/png', size: 4 }] },
  { type: 'get_workspaces' },
  { type: 'create_workspace', name: 'Workspace', cwd: 'C:\\work' },
  { type: 'update_workspace', id: 'w1', name: '', gridColumns: 4, gridRows: 3, selectedAgentIds: ['a1', '', ''], lockedAgentIds: [], testUrl: '', googleDocsTrackerEnabled: false },
  { type: 'reorder_workspaces', orderedIds: ['w1'] },
  { type: 'delete_workspace', id: 'w1' },
  { type: 'set_active_workspace', id: 'w1' },
  { type: 'send_qa_message', workspaceId: 'w1', sourceAgentId: 'a1', content: 'test', rerunOf: 'run0' },
  { type: 'abort_qa_test', workspaceId: 'w1' },
  { type: 'handoff_qa_run', workspaceId: 'w1', runId: 'run1' },
  { type: 'provision_atlas_agent', workspaceId: 'w1', projectCwd: '/work' },
  { type: 'rescan_atlas', workspaceId: 'w1' },
  { type: 'resume_atlas', workspaceId: 'w1' },
  { type: 'discard_atlas_candidate', workspaceId: 'w1' },
  { type: 'create_terminal', agentId: 'a1', command: '' },
  { type: 'kill_terminal', id: 't1' },
  { type: 'get_terminals' },
  { type: 'refresh_limits' },
  { type: 'kill_all' },
  { type: 'ping' },
];

test('every declared client command has a valid strict wire shape', () => {
  for (const message of validMessages) {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  }
  expect(new Set(validMessages.map(message => message.type)).size).toBe(validMessages.length);
});

test('every command rejects undeclared fields before service dispatch', () => {
  for (const message of validMessages) {
    expect(() => validateClientMessage({ ...message, internalMutation: true })).toThrow('Unexpected field');
  }
  expect(() => validateClientMessage({
    type: 'update_workspace',
    id: 'w1',
    atlasRun: { status: 'completed' },
    qaRuns: [],
  })).toThrow('Unexpected field');
  expect(() => validateClientMessage({
    type: 'update_settings',
    settings: { secret: 'should-not-persist' },
  })).toThrow('Unexpected field');
});

test('malformed types, required fields, enums, ranges, and image arrays are rejected', () => {
  const invalid: unknown[] = [
    null,
    [],
    { type: 1 },
    { type: 'missing-command' },
    { type: 'send_message', agentId: '', content: 'x' },
    { type: 'send_message', agentId: 'a1', content: 7 },
    { type: 'resolve_model_mismatch', id: 'a1', action: 'anything' },
    { type: 'update_agent', id: 'a1', provider: 'other' },
    { type: 'create_workspace', name: 'Workspace' },
    { type: 'create_workspace', name: 'Workspace', cwd: '   ' },
    { type: 'update_workspace', id: 'w1', gridColumns: 0 },
    { type: 'update_settings', settings: { sidebarWidth: Number.NaN } },
    { type: 'send_images', agentId: 'a1', images: [] },
    { type: 'send_uploaded_images', agentId: 'a1', images: [{ path: '/x', name: 'x', mimeType: 'image/png', size: -1 }] },
  ];
  for (const value of invalid) {
    expect(() => validateClientMessage(value)).toThrow(ClientMessageValidationError);
  }
});

test('selected agent grids accept empty slots without weakening other ID arrays', () => {
  expect(() => validateClientMessage({
    type: 'update_workspace',
    id: 'w1',
    selectedAgentIds: ['a1', '', 'a2', ''],
  })).not.toThrow();
  expect(() => validateClientMessage({
    type: 'update_settings',
    settings: { selectedAgentIds: ['', 'a1'] },
  })).not.toThrow();
  expect(() => validateClientMessage({
    type: 'update_workspace',
    id: 'w1',
    selectedAgentIds: ['a1', '   '],
  })).toThrow('selectedAgentIds[1] cannot be empty');
  expect(() => validateClientMessage({
    type: 'update_workspace',
    id: 'w1',
    lockedAgentIds: [''],
  })).toThrow('lockedAgentIds[0] cannot be empty');
});

test('wire decoder rejects oversized, invalid JSON, and invalid UTF-8 payloads', () => {
  expect(() => parseClientMessage('{', 100)).toThrow('not valid JSON');
  expect(() => parseClientMessage(new Uint8Array([0xc3, 0x28]), 100)).toThrow('not valid UTF-8');
  expect(() => parseClientMessage(JSON.stringify({ type: 'ping' }), 4)).toThrow('exceeds 4 bytes');
});

test('hostile JSON values never escape validation as an unexpected exception', () => {
  let state = 0x9e3779b9;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const atoms: unknown[] = [null, true, false, 0, -1, '', 'ping', [], {}, { type: null }];
  for (let i = 0; i < 500; i++) {
    const value = {
      type: atoms[random() % atoms.length],
      [(random() & 1) ? '__proto__' : `field${random() % 20}`]: atoms[random() % atoms.length],
    };
    try {
      validateClientMessage(value);
      throw new Error('hostile fixture unexpectedly validated');
    } catch (error) {
      expect(error).toBeInstanceOf(ClientMessageValidationError);
    }
  }
});
