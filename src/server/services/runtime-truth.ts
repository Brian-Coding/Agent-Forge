import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type {
  ProviderAuthSnapshot,
  RuntimeDriftState,
  RuntimeHealth,
  RuntimeManifest,
  RuntimeProviderIdentity,
} from '../../shared/runtime-health';
import { AUTH_CONTRACT_VERSION } from '../../shared/runtime-health';
import { currentAuthCoordinator } from '../auth/provider-auth-coordinator';
import { versionProbeEnv } from '../auth/probe-env';
import { commandSession } from './command-session';
import { collectBoundedProcess } from './bounded-subprocess';
import { resolveCliBinary } from '../utils';
import { resolveClaudeLaunchCommand } from '../agents/adapters/claude';
import { resolveCodexLaunchCommand } from '../agents/adapters/codex';

export const CRITICAL_RUNTIME_FILES = [
  'src/server/index.ts',
  'src/server/ws.ts',
  'src/server/process-startup.ts',
  'src/server/agents/adapters/claude.ts',
  'src/server/agents/adapters/codex.ts',
  'src/server/services/chat.service.ts',
  'src/shared/protocol.ts',
  'src/shared/runtime-health.ts',
] as const;

export const SOURCE_ROOT = resolve(join(import.meta.dir, '../../..'));

export interface GitIdentity {
  commit?: string;
  dirty: boolean;
}

export interface RuntimeTruthOptions {
  now?: () => number;
  serverSessionId?: string;
  startedAt?: number;
  bunVersion?: string;
  sourceRoot?: string;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
  readGitIdentity?: (sourceRoot: string) => Promise<GitIdentity> | GitIdentity;
  probeProviders?: () => Promise<RuntimeProviderIdentity[]> | RuntimeProviderIdentity[];
  getAuthSnapshots?: (providers: RuntimeProviderIdentity[], checkedAt: number) => Promise<ProviderAuthSnapshot[]> | ProviderAuthSnapshot[];
}

interface StartupCapture {
  serverSessionId: string;
  startedAt: number;
  bunVersion: string;
  source: GitIdentity;
  runningFingerprint: string;
  providers: RuntimeProviderIdentity[];
}

export function createRuntimeTruth(options: RuntimeTruthOptions = {}) {
  const now = options.now ?? Date.now;
  const sourceRoot = options.sourceRoot ?? SOURCE_ROOT;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const fileExists = options.fileExists ?? existsSync;
  const bunVersion = options.bunVersion ?? Bun.version;
  let capture: StartupCapture | null = null;

  const fingerprintAt = (label: 'running' | 'disk'): { fingerprint?: string; complete: boolean } => {
    const chunks: string[] = [];
    let complete = true;
    for (const relative of CRITICAL_RUNTIME_FILES) {
      const absolute = join(sourceRoot, relative);
      if (!fileExists(absolute)) {
        complete = false;
        chunks.push(`${relative}:missing\n`);
        continue;
      }
      try {
        chunks.push(`${relative}\n${readFile(absolute)}\n`);
      } catch {
        complete = false;
        chunks.push(`${relative}:unreadable\n`);
      }
    }
    if (chunks.length === 0) return { complete: false };
    return {
      fingerprint: createHash('sha256').update(chunks.join('\0')).digest('hex'),
      complete,
    };
  };

  const driftBetween = (running: string, disk?: { fingerprint?: string; complete: boolean }): RuntimeDriftState => {
    if (!disk?.fingerprint) return 'unknown';
    if (!disk.complete) return 'unknown';
    return disk.fingerprint === running ? 'current' : 'restart-required';
  };

  const buildManifest = async (): Promise<RuntimeManifest> => {
    if (!capture) await captureStartup();
    const started = capture!;
    const disk = fingerprintAt('disk');
    return {
      contractVersion: AUTH_CONTRACT_VERSION,
      serverSessionId: started.serverSessionId,
      startedAt: started.startedAt,
      bunVersion: started.bunVersion,
      source: started.source,
      runningFingerprint: started.runningFingerprint,
      ...(disk.fingerprint ? { onDiskFingerprint: disk.fingerprint } : {}),
      drift: driftBetween(started.runningFingerprint, disk),
      providers: started.providers,
    };
  };

  async function captureStartup(): Promise<StartupCapture> {
    const running = fingerprintAt('running');
    const source = await Promise.resolve(
      options.readGitIdentity
        ? options.readGitIdentity(sourceRoot)
        : readGitIdentity(sourceRoot),
    );
    const providers = await Promise.resolve(
      options.probeProviders
        ? options.probeProviders()
        : probeProviderIdentities(),
    );
    capture = {
      serverSessionId: options.serverSessionId ?? commandSession.serverSessionId,
      startedAt: options.startedAt ?? now(),
      bunVersion,
      source,
      runningFingerprint: running.fingerprint ?? createHash('sha256').update('unknown').digest('hex'),
      providers,
    };
    return capture;
  }

  return {
    captureStartup,
    async getHealth(): Promise<RuntimeHealth> {
      const runtime = await buildManifest();
      const checkedAt = now();
      const auth = options.getAuthSnapshots
        ? await options.getAuthSnapshots(runtime.providers, checkedAt)
        : await currentAuthCoordinator().snapshotsFor(runtime.providers);
      return {
        contractVersion: AUTH_CONTRACT_VERSION,
        runtime,
        auth,
      };
    },
    peekCompact() {
      if (!capture) return null;
      const disk = fingerprintAt('disk');
      return {
        startedAt: capture.startedAt,
        bunVersion: capture.bunVersion,
        drift: driftBetween(capture.runningFingerprint, disk),
        contractVersion: AUTH_CONTRACT_VERSION,
      };
    },
  };
}

export type RuntimeTruth = ReturnType<typeof createRuntimeTruth>;

export const runtimeTruth: RuntimeTruth = (globalThis as any).__runtimeTruth ??= createRuntimeTruth();
(globalThis as any).__runtimeTruth = runtimeTruth;

function currentRuntimeTruth(): RuntimeTruth {
  return ((globalThis as any).__runtimeTruth as RuntimeTruth | undefined) ?? runtimeTruth;
}

export async function captureRuntimeStartup(): Promise<void> {
  await currentRuntimeTruth().captureStartup();
}

export async function getRuntimeHealth(): Promise<RuntimeHealth> {
  return currentRuntimeTruth().getHealth();
}

export function peekRuntimeCompact(): {
  startedAt: number;
  bunVersion: string;
  drift: RuntimeDriftState;
  contractVersion: number;
} | null {
  return currentRuntimeTruth().peekCompact();
}

export function parseCliVersion(text: string): string | undefined {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
  const match = line.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/);
  return match?.[1];
}

export { versionProbeEnv } from '../auth/probe-env';

export async function readGitIdentity(sourceRoot: string): Promise<GitIdentity> {
  const commit = readGitCommit(sourceRoot);
  const dirty = await readGitDirty(sourceRoot);
  return { ...(commit ? { commit } : {}), dirty };
}

function readGitCommit(sourceRoot: string): string | undefined {
  try {
    const gitDir = resolveGitDir(sourceRoot);
    if (!gitDir) return undefined;
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const refMatch = head.match(/^ref:\s*(.+)$/);
    if (!refMatch) return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 40) : undefined;
    const ref = readFileSync(join(gitDir, refMatch[1]!), 'utf8').trim();
    return /^[0-9a-f]{7,40}$/i.test(ref) ? ref : undefined;
  } catch {
    return undefined;
  }
}

function resolveGitDir(sourceRoot: string): string | undefined {
  const dotGit = join(sourceRoot, '.git');
  if (!existsSync(dotGit)) return undefined;
  try {
    const info = statSync(dotGit);
    if (info.isDirectory()) return dotGit;
    if (!info.isFile()) return undefined;
    const content = readFileSync(dotGit, 'utf8');
    const pointed = content.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointed) return undefined;
    return isAbsolute(pointed) ? pointed : resolve(sourceRoot, pointed);
  } catch {
    return undefined;
  }
}

async function readGitDirty(sourceRoot: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['git', '-C', sourceRoot, 'status', '--porcelain', '-uno'], { detached: process.platform !== 'win32',
      stdout: 'pipe',
      stderr: 'pipe',
      env: versionProbeEnv(),
    });
    const result = await collectBoundedProcess(proc, {
      timeoutMs: 3_000,
      terminationTimeoutMs: 1_000,
      maxChars: 8_192,
      retainOutput: 'head',
      label: 'runtime source dirty check',
      terminate: () => { try { proc.kill(); } catch {} },
    });
    if (result.timedOut || result.error || result.exitCode !== 0) return false;
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function probeProviderIdentities(): Promise<RuntimeProviderIdentity[]> {
  return [
    await probeOneProvider('claude', () => resolveClaudeLaunchCommand(resolveCliBinary('claude'))),
    await probeOneProvider('codex', () => resolveCodexLaunchCommand(resolveCliBinary('codex'))),
  ];
}

async function probeOneProvider(
  provider: 'claude' | 'codex',
  command: () => string[],
): Promise<RuntimeProviderIdentity> {
  try {
    const argv = command();
    const proc = Bun.spawn([...argv, '--version'], { detached: process.platform !== 'win32',
      stdout: 'pipe',
      stderr: 'pipe',
      env: versionProbeEnv(),
    });
    const result = await collectBoundedProcess(proc, {
      timeoutMs: 3_000,
      terminationTimeoutMs: 1_000,
      maxChars: 4_096,
      retainOutput: 'head',
      label: `${provider} version probe`,
      terminate: () => { try { proc.kill(); } catch {} },
    });
    if (result.timedOut || result.error) {
      return { provider, cliName: provider, available: false };
    }
    const version = parseCliVersion(result.stdout) ?? parseCliVersion(result.stderr);
    return {
      provider,
      cliName: provider,
      available: result.exitCode === 0 || Boolean(version),
      ...(version ? { cliVersion: version } : {}),
    };
  } catch {
    return { provider, cliName: provider, available: false };
  }
}
