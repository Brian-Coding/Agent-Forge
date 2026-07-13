import { createCliEnv, killProcessTree, resolveCliBinary, safeSpawn } from '../utils';

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
  let proc: ReturnType<typeof safeSpawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    proc = safeSpawn([resolveCliBinary(binary), ...args], {
      cwd: process.cwd(),
      env: createCliEnv(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    proc.stdin.end();
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>(resolve => {
        timer = setTimeout(async () => {
          if (proc) await killProcessTree(proc);
          resolve(-1);
        }, COMMAND_TIMEOUT_MS);
      }),
    ]);
    const output = `${await stdoutPromise}\n${await stderrPromise}`.trim().slice(0, 2_000);
    return { ok: exitCode === 0, output, unavailable: false };
  } catch (error: any) {
    const message = String(error?.message || error || 'CLI unavailable');
    return { ok: false, output: message.slice(0, 2_000), unavailable: /ENOENT|not found|cannot find/i.test(message) };
  } finally {
    if (timer) clearTimeout(timer);
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
