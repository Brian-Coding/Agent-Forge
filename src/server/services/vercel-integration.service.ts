import { createCliEnv, killProcessTree, resolveCliBinary, safeSpawn } from '../utils';
import { resolveClaudeLaunchCommand } from '../agents/adapters/claude';
import { resolveCodexLaunchCommand } from '../agents/adapters/codex';
import { collectBoundedProcess } from './bounded-subprocess';

export const VERCEL_MCP_URL = 'https://mcp.vercel.com';
const COMMAND_TIMEOUT_MS = 10_000;

export interface VercelProviderStatus {
  available: boolean;
  configured: boolean;
  error?: string;
}

export interface VercelIntegrationStatus {
  endpoint: string;
  codex: VercelProviderStatus;
  claude: VercelProviderStatus;
  ready: boolean;
  authentication: {
    codex: string;
    claude: string;
  };
}

interface CommandResult {
  ok: boolean;
  output: string;
  unavailable: boolean;
}

export function vercelMcpCommands() {
  return {
    codex: {
      status: ['mcp', 'get', 'vercel', '--json'],
      add: ['mcp', 'add', 'vercel', '--url', VERCEL_MCP_URL],
    },
    claude: {
      status: ['mcp', 'get', 'vercel'],
      add: ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'vercel', VERCEL_MCP_URL],
    },
  } as const;
}

async function runCli(binary: 'codex' | 'claude', args: readonly string[]): Promise<CommandResult> {
  try {
    const resolved = resolveCliBinary(binary);
    const command = binary === 'codex'
      ? resolveCodexLaunchCommand(resolved)
      : resolveClaudeLaunchCommand(resolved);
    const proc = safeSpawn([...command, ...args], {
      cwd: process.cwd(),
      env: createCliEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.end();
    const result = await collectBoundedProcess(proc, {
      timeoutMs: COMMAND_TIMEOUT_MS,
      terminationTimeoutMs: 3_000,
      maxChars: 64_000,
      label: `${binary} MCP command`,
      terminate: () => killProcessTree(proc),
    });
    const output = (result.error || `${result.stdout}\n${result.stderr}`.trim()).slice(0, 2_000);
    return { ok: !result.timedOut && !result.error && result.exitCode === 0, output, unavailable: false };
  } catch (error: any) {
    const message = String(error?.message || error || 'CLI unavailable');
    return { ok: false, output: message.slice(0, 2_000), unavailable: /ENOENT|not found|cannot find/i.test(message) };
  }
}

async function providerStatus(provider: 'codex' | 'claude'): Promise<VercelProviderStatus> {
  const result = await runCli(provider, vercelMcpCommands()[provider].status);
  return {
    available: !result.unavailable,
    configured: result.ok,
    ...(!result.ok && !result.unavailable ? { error: result.output || 'Not configured' } : {}),
  };
}

function withSharedFields(codex: VercelProviderStatus, claude: VercelProviderStatus): VercelIntegrationStatus {
  return {
    endpoint: VERCEL_MCP_URL,
    codex,
    claude,
    ready: codex.configured && claude.configured,
    authentication: {
      codex: 'codex mcp login vercel',
      claude: 'Open Claude Code, run /mcp, choose vercel, then Authenticate.',
    },
  };
}

export const vercelIntegrationService = {
  async getStatus(): Promise<VercelIntegrationStatus> {
    const [codex, claude] = await Promise.all([providerStatus('codex'), providerStatus('claude')]);
    return withSharedFields(codex, claude);
  },

  async configure(): Promise<VercelIntegrationStatus> {
    const current = await this.getStatus();
    const commands = vercelMcpCommands();
    if (!current.codex.configured && current.codex.available) await runCli('codex', commands.codex.add);
    if (!current.claude.configured && current.claude.available) await runCli('claude', commands.claude.add);
    return this.getStatus();
  },
};
