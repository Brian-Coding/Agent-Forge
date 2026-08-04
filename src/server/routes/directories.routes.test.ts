import { describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { handleDirectories } from './directories.routes';

describe('directories route', () => {
  test('defaults a fresh folder picker to the user development directory', async () => {
    const response = await handleDirectories(new Request('http://localhost/api/directories'));
    const body = await response.json();

    const developmentPath = join(homedir(), 'dev');
    expect(body.defaultPath).toBe(existsSync(developmentPath) ? developmentPath : body.documentsPath);
    expect(body.path).toBe(homedir());
  });
});
