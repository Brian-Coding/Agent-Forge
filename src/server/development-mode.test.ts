import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const serverSource = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');

test('the local harness does not inject Bun HMR into the browser', () => {
  expect(serverSource).toContain('development: false');
  expect(serverSource).not.toContain('hmr: true');
});
