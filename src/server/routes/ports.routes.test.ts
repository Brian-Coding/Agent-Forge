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
