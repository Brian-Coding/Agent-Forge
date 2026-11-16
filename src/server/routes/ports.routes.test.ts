import { expect, test } from 'bun:test';
import { handleKillPort, parseKillPid } from './ports.routes';

test('kill PID validation rejects process-group, fractional, string, and self targets', () => {
  for (const value of [undefined, null, '', '42', 0, 1, -1, -99, 2.5, Number.NaN, Number.POSITIVE_INFINITY, process.pid]) {
    expect(parseKillPid(value)).toBeNull();
  }
  expect(parseKillPid(42)).toBe(42);
});

test('invalid kill requests fail before spawning an operating-system command', async () => {
  for (const pid of [-1, 0, 1, process.pid, '42']) {
    const response = await handleKillPort(new Request('http://localhost/api/ports/kill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid or unsafe pid' });
  }
});

test('malformed JSON returns a bounded error response', async () => {
  const response = await handleKillPort(new Request('http://localhost/api/ports/kill', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  }));
  expect(response.status).toBe(500);
  expect((await response.json() as any).ok).toBe(false);
});

test('a numeric PID alone never authorizes an external process stop', async () => {
  const response = await handleKillPort(new Request('http://localhost/api/ports/kill', {
    method: 'POST', body: JSON.stringify({ pid: 123456, port: 3000 }),
  }));
  expect(response.status).toBe(409);
});

test('listener identity rejects reused PIDs even within the same second tolerance window', async () => {
  const { sameListenerIdentity } = await import('./ports.routes');
  const original = { pid: 42, name: 'node', startTimeMs: 1000 };
  expect(sameListenerIdentity(original, { ...original })).toBe(true);
  expect(sameListenerIdentity(original, { ...original, startTimeMs: 2000 })).toBe(false);
  expect(sameListenerIdentity(original, { ...original, name: 'other' })).toBe(false);
  expect(sameListenerIdentity(original, { pid: 42, name: 'node' })).toBe(false);
});
