import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERCEL_MCP_URL, vercelIntegrationService, vercelMcpCommands } from './vercel-integration.service';

test('Vercel MCP commands configure both CLIs globally', () => {
  const commands = vercelMcpCommands();
  expect(commands.codex.add).toEqual(['mcp', 'add', 'vercel', '--url', VERCEL_MCP_URL]);
  expect(commands.claude.add).toEqual([
    'mcp', 'add', '--scope', 'user', '--transport', 'http', 'vercel', VERCEL_MCP_URL,
  ]);
  expect(commands.codex.status).toContain('vercel');
  expect(commands.claude.status).toContain('vercel');
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

test('Vercel status and configuration execute both real CLI boundaries without confusing nonzero status with success', async () => {
  const root = join(tmpdir(), `agent forge vercel cli ${randomUUID()}`);
  const originalPath = process.env.PATH;
  const cache = (globalThis as any).__cliBinaryCache as Map<string, string>;
  const originalCache = new Map(cache);
  await mkdir(root, { recursive: true });

  const writeFakeCli = async (name: 'claude' | 'codex', entry: string) => {
    if (process.platform === 'win32') {
      await Bun.write(join(root, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
    } else {
      const shim = join(root, name);
      await Bun.write(shim, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"\n`);
      await chmod(shim, 0o755);
    }
  };

  try {
    for (const provider of ['claude', 'codex'] as const) {
      const packageDir = provider === 'claude'
        ? join(root, 'node_modules', '@anthropic-ai', 'claude-code')
        : join(root, 'node_modules', '@openai', 'codex', 'bin');
      await mkdir(packageDir, { recursive: true });
      const entry = join(packageDir, provider === 'claude' ? 'cli.js' : 'codex.js');
      const marker = join(root, `${provider}.configured`);
      await Bun.write(entry, [
        "const fs = require('node:fs');",
        `const marker = ${JSON.stringify(marker)};`,
        'const args = process.argv.slice(2);',
        "if (args[0] !== 'mcp') { process.stderr.write('unexpected command'); process.exit(19); }",
        "if (args[1] === 'get') {",
        "  if (!fs.existsSync(marker)) { process.stderr.write('vercel is not configured'); process.exit(7); }",
        "  process.stdout.write(JSON.stringify({ name: 'vercel', url: 'https://mcp.vercel.com' }));",
        "} else if (args[1] === 'add') {",
        "  fs.writeFileSync(marker, 'configured');",
        "  process.stdout.write('added');",
        "} else { process.stderr.write('unexpected mcp action'); process.exit(20); }",
      ].join('\n'));
      await writeFakeCli(provider, entry);
    }

    process.env.PATH = `${root}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
    // Pin fixtures so preferred user-local installations cannot run in this test.
    for (const provider of ['claude', 'codex']) {
      cache.set(provider, join(root, process.platform === 'win32' ? `${provider}.cmd` : provider));
    }

    const before = await vercelIntegrationService.getStatus();
    expect(before.ready).toBe(false);
    expect(before.codex).toMatchObject({ available: true, configured: false });
    expect(before.claude).toMatchObject({ available: true, configured: false });
    expect(before.codex.error).toContain('not configured');
    expect(before.claude.error).toContain('not configured');

    const configured = await vercelIntegrationService.configure();
    expect(configured.ready).toBe(true);
    expect(configured.codex).toEqual({ available: true, configured: true });
    expect(configured.claude).toEqual({ available: true, configured: true });
    expect(existsSync(join(root, 'codex.configured'))).toBe(true);
    expect(existsSync(join(root, 'claude.configured'))).toBe(true);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    cache.clear();
    for (const [name, path] of originalCache) cache.set(name, path);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
