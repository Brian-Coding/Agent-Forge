import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const serverSource = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');

test('the local harness does not inject Bun HMR into the browser', () => {
  expect(serverSource).toContain('development: false');
  expect(serverSource).not.toContain('hmr: true');
});

test('the server bind is exclusive so a second instance cannot share the port', () => {
  expect(serverSource).toContain('reusePort: false');
  // development: false alone turns SO_REUSEPORT on in Bun; reusePort: false must win.
  const options = { hostname: '127.0.0.1', development: false, reusePort: false, fetch: () => new Response('ok') } as const;
  const first = Bun.serve({ ...options, port: 0 });
  try {
    expect(() => Bun.serve({ ...options, port: first.port })).toThrow();
  } finally {
    first.stop(true);
  }
});
