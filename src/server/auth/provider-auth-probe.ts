import type { AgentProvider } from '../../shared/protocol';
import type { ProviderAuthSnapshot } from '../../shared/runtime-health';
import { unprobedAuthSnapshot } from '../../shared/runtime-health';
import { collectBoundedProcess } from '../services/bounded-subprocess';
import { resolveCliBinary } from '../utils';
import { classifyClaudeAuthOutput } from './classify-claude-auth';
import { versionProbeEnv } from './probe-env';

export const AUTH_STATUS_TIMEOUT_MS = 5_000;

export interface AuthStatusRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  missing?: boolean;
}

export interface ProviderAuthProbe {
  provider: AgentProvider;
  run(input: {
    env?: Record<string, string | undefined>;
    cliVersion?: string;
    now?: number;
  }): Promise<ProviderAuthSnapshot>;
}

export function createClaudeAuthProbe(
  runStatus: (env: Record<string, string | undefined>) => Promise<AuthStatusRunResult> = runClaudeAuthStatus,
): ProviderAuthProbe {
  return {
    provider: 'claude',
    async run({ env = {}, cliVersion, now = Date.now() }) {
      const result = await runStatus(env);
      const classified = classifyClaudeAuthOutput({
        kind: 'auth-status',
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
        missing: result.missing,
        env,
        cliVersion,
      });
      return {
        provider: 'claude',
        state: classified.state,
        credentialMode: classified.credentialMode,
        evidence: classified.evidence,
        reasonCode: classified.reasonCode,
        checkedAt: now,
        ...(cliVersion ? { cliVersion } : {}),
        ...(classified.recoveryAction ? { recoveryAction: classified.recoveryAction } : {}),
      };
    },
  };
}

export function createCodexAuthProbe(): ProviderAuthProbe {
  return {
    provider: 'codex',
    async run({ cliVersion, now = Date.now() }) {
      return unprobedAuthSnapshot('codex', now, cliVersion);
    },
  };
}

export async function runClaudeAuthStatus(
  env: Record<string, string | undefined> = process.env,
): Promise<AuthStatusRunResult> {
  try {
    const command = [resolveCliBinary('claude')];
    const proc = Bun.spawn([...command, 'auth', 'status'], { detached: process.platform !== 'win32',
      stdout: 'pipe',
      stderr: 'pipe',
      env: versionProbeEnv(env),
    });
    const result = await collectBoundedProcess(proc, {
      timeoutMs: AUTH_STATUS_TIMEOUT_MS,
      terminationTimeoutMs: 1_000,
      maxChars: 8_192,
      retainOutput: 'head',
      label: 'Claude auth status shadow probe',
      terminate: () => { try { proc.kill(); } catch {} },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: '',
      timedOut: result.timedOut,
      missing: Boolean(result.error && /ENOENT|not found/i.test(result.error)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      missing: /ENOENT|not found/i.test(message),
    };
  }
}
