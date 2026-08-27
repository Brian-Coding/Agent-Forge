import { afterEach, expect, test } from 'bun:test';
import { clientLastPong, clients } from './broadcast';
import { runWebSocketHeartbeat, websocketHandlers } from './ws';

interface FakeSocket {
  sent: any[];
  pingCalls: number;
  closeCalls: number;
  send(data: string): void;
  ping(): void;
  close(): void;
}

function fakeSocket(): FakeSocket {
  return {
    sent: [],
    pingCalls: 0,
    closeCalls: 0,
    send(data) { this.sent.push(JSON.parse(data)); },
    ping() { this.pingCalls++; },
    close() { this.closeCalls++; },
  };
}

afterEach(() => {
  clients.clear();
  clientLastPong.clear();
});

test('websocket open publishes a coherent snapshot and close releases all client state', () => {
  const ws = fakeSocket();

  websocketHandlers.open(ws as any);

  const messageTypes = ws.sent.map(message => message.type);
  expect(messageTypes).toContain('server_session');
  expect(messageTypes).toContain('agents_list');
  expect(messageTypes).toContain('settings');
  expect(messageTypes).toContain('workspaces_list');
  expect(messageTypes).toContain('terminals_list');
  expect(messageTypes).toContain('usage_report');
  expect(clients.has(ws as any)).toBe(true);
  expect(clientLastPong.get(ws as any)).toBeNumber();

  websocketHandlers.close(ws as any);
  expect(clients.has(ws as any)).toBe(false);
  expect(clientLastPong.has(ws as any)).toBe(false);
});

test('websocket dispatch handles read commands and rejects malformed payloads without escaping errors', async () => {
  const ws = fakeSocket();
  websocketHandlers.open(ws as any);
  ws.sent.length = 0;

  websocketHandlers.message(ws as any, JSON.stringify({ type: 'ping' }));
  websocketHandlers.message(ws as any, JSON.stringify({ type: 'list_agents' }));
  websocketHandlers.message(ws as any, JSON.stringify({ type: 'get_settings' }));
  websocketHandlers.message(ws as any, JSON.stringify({ type: 'get_workspaces' }));
  websocketHandlers.message(ws as any, JSON.stringify({ type: 'get_terminals' }));
  websocketHandlers.message(ws as any, JSON.stringify({ type: 'get_shared_context' }));
  websocketHandlers.message(ws as any, JSON.stringify({ type: 'get_history', agentId: 'missing-agent' }));
  websocketHandlers.message(ws as any, '{broken json');
  websocketHandlers.message(ws as any, JSON.stringify({ type: 'ping', undeclared: true }));
  await Bun.sleep(0);

  expect(ws.sent.map(message => message.type)).toEqual([
    'pong',
    'agents_list',
    'settings',
    'workspaces_list',
    'terminals_list',
    'shared_context',
    'history',
    'error',
    'error',
  ]);
  expect(ws.sent.at(-2)?.message).toContain('not valid JSON');
  expect(ws.sent.at(-1)?.message).toContain('Unexpected field');
});

test('a request ID receives an idempotent command ack and a changed payload is rejected', async () => {
  const ws = fakeSocket();
  websocketHandlers.open(ws as any);
  ws.sent.length = 0;

  const envelope = {
    protocolVersion: 1,
    requestId: 'req-chat-1',
    clientSessionId: 'tab-1',
    sentAt: 1,
    type: 'send_message',
    agentId: 'missing-agent',
    content: 'hello',
  };
  websocketHandlers.message(ws as any, JSON.stringify(envelope));
  await Bun.sleep(20);
  const first = ws.sent.find(message => message.type === 'command_ack');
  expect(first).toMatchObject({
    type: 'command_ack',
    requestId: 'req-chat-1',
    status: 'accepted',
  });

  ws.sent.length = 0;
  websocketHandlers.message(ws as any, JSON.stringify(envelope));
  await Bun.sleep(20);
  expect(ws.sent.find(message => message.type === 'command_ack')).toMatchObject({
    requestId: 'req-chat-1',
    status: 'duplicate',
  });

  ws.sent.length = 0;
  websocketHandlers.message(ws as any, JSON.stringify({ ...envelope, content: 'different' }));
  await Bun.sleep(20);
  expect(ws.sent.find(message => message.type === 'command_ack')).toMatchObject({
    requestId: 'req-chat-1',
    status: 'rejected',
    reasonCode: 'request-id-conflict',
  });
});

test('the single heartbeat closes stale clients at most once and keeps fresh clients alive', () => {
  const stale = fakeSocket();
  const fresh = fakeSocket();
  const now = 1_000_000;
  clients.add(stale as any);
  clients.add(fresh as any);
  clientLastPong.set(stale as any, now - 40_001);
  clientLastPong.set(fresh as any, now - 39_999);

  runWebSocketHeartbeat(now);
  runWebSocketHeartbeat(now + 1);

  expect(stale.closeCalls).toBe(1);
  expect(stale.pingCalls).toBe(0);
  expect(clients.has(stale as any)).toBe(false);
  expect(clientLastPong.has(stale as any)).toBe(false);
  expect(fresh.closeCalls).toBe(0);
  expect(fresh.pingCalls).toBe(2);
  expect(clients.has(fresh as any)).toBe(true);
  expect((globalThis as any).__websocketHeartbeatTimer).toBeTruthy();
});
