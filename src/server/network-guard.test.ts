import { test, expect } from 'bun:test';
import { createNetworkGuard } from './network-guard';

test('exact browser origin plus per-launch capability protects mutation and WebSocket channels', () => {
  const guard = createNetworkGuard();
  const origin = 'http://127.0.0.1:3333';
  for (const other of ['http://127.0.0.1:3334', 'http://localhost:3333', 'http://[::1]:3333', 'https://127.0.0.1:3333', 'https://external.example', 'null']) {
    expect(guard.allows(new Request(origin, { headers: { origin: other, upgrade: 'websocket', 'sec-websocket-protocol': 'forge-auth.' + guard.token } }), origin)).toBe(false);
    expect(guard.allows(new Request(origin, { method: 'POST', headers: { origin: other, 'x-forge-token': guard.token } }), origin)).toBe(false);
  }
  for (const headers of ([{}, { origin }] as Record<string, string>[])) {
    expect(guard.allows(new Request(origin, { method: 'POST', headers }), origin)).toBe(false);
    expect(guard.allows(new Request(origin, { headers: { ...headers, upgrade: 'websocket' } }), origin)).toBe(false);
    expect(guard.allows(new Request(origin, { method: 'POST', headers: { ...headers, 'x-forge-token': guard.token } }), origin)).toBe(true);
  }
  expect(guard.allows(new Request(origin, { headers: { origin, upgrade: 'websocket', 'sec-websocket-protocol': 'forge-auth.' + guard.token } }), origin)).toBe(true);
  expect(guard.allows(new Request(origin, { method: 'POST', headers: { origin, 'x-forge-token': createNetworkGuard().token } }), origin)).toBe(false);
  expect(guard.allows(new Request(origin, { headers: { host: 'localhost:3333' } }), origin)).toBe(false);
});
