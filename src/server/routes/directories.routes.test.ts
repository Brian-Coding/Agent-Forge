import { describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { handleDirectories } from './directories.routes';
import { safeRemoveTree } from '../services/safe-filesystem.mjs';

describe('directories route', () => {
  test('pasted paths navigate outside home and reject missing paths or files', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'forge-picker-'));
    const root = join(fixtureRoot, 'project');
    await mkdir(root);
    try {
      await mkdir(join(root, 'child'));
      await writeFile(join(root, 'file.txt'), 'fixture');
      const request = (path: string) => handleDirectories(new Request('http://localhost/api/directories?path=' + encodeURIComponent(path)));
      const response = await request(root);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ path: root, directories: [{ name: 'child', path: join(root, 'child') }] });
      for (const path of [join(root, 'missing'), join(root, 'file.txt'), 'relative/path']) {
        const invalid = await request(path);
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: expect.any(String) });
      }
      const home = await request('~/');
      expect(await home.json()).toMatchObject({ path: homedir() });
    } finally {
      await safeRemoveTree({ targetPath: root, allowedRoot: fixtureRoot, allowNonEmpty: true, mode: 'delete', permanent: true, reason: 'Remove isolated folder picker fixture' });
    }
  });
  test('defaults a fresh folder picker to the user development directory', async () => {
    const response = await handleDirectories(new Request('http://localhost/api/directories'));
    const body = await response.json();

    const developmentPath = join(homedir(), 'dev');
    expect(body.defaultPath).toBe(existsSync(developmentPath) ? developmentPath : body.documentsPath);
    expect(body.path).toBe(homedir());
  });
});
