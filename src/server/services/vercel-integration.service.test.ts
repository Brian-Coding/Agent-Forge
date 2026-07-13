import { expect, test } from 'bun:test';
import { VERCEL_MCP_URL, vercelMcpCommands } from './vercel-integration.service';

test('Vercel MCP commands configure both CLIs globally', () => {
  const commands = vercelMcpCommands();
  expect(commands.codex.add).toEqual(['mcp', 'add', 'vercel', '--url', VERCEL_MCP_URL]);
  expect(commands.claude.add).toEqual([
    'mcp', 'add', '--scope', 'user', '--transport', 'http', 'vercel', VERCEL_MCP_URL,
  ]);
  expect(commands.codex.status).toContain('vercel');
  expect(commands.claude.status).toContain('vercel');
});
