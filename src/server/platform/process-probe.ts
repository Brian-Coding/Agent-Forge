export type ProcessProbeStatus =
  | 'matched'
  | 'partial'
  | 'missing'
  | 'denied'
  | 'timeout'
  | 'ambiguous';

export interface ProcessIdentity {
  pid: number;
  name?: string;
  startTimeMs?: number;
  parentPid?: number;
}

export interface ProcessProbeResult {
  status: ProcessProbeStatus;
  identity?: ProcessIdentity;
  error?: string;
}

export interface ProcessProbe {
  probe(pid: number): Promise<ProcessProbeResult>;
  probeMany(pids: readonly number[]): Promise<Map<number, ProcessProbeResult>>;
}

export type ProcessProbeFn = (pid: number) => Promise<ProcessProbeResult>;

const NAME_STRIP = /\.exe$/i;

export function normalizeProcessName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const trimmed = name.trim().toLowerCase().replace(NAME_STRIP, '');
  return trimmed || undefined;
}

export function createFakeProcessProbe(seed: Map<number, ProcessProbeResult> = new Map()): ProcessProbe {
  return {
    async probe(pid) {
      return seed.get(pid) ?? { status: 'missing' };
    },
    async probeMany(pids) {
      const results = new Map<number, ProcessProbeResult>();
      for (const pid of pids) results.set(pid, seed.get(pid) ?? { status: 'missing' });
      return results;
    },
  };
}

export function createMapProcessProbe(fn: ProcessProbeFn): ProcessProbe {
  return {
    probe: fn,
    async probeMany(pids) {
      const results = new Map<number, ProcessProbeResult>();
      await Promise.all(pids.map(async pid => {
        results.set(pid, await fn(pid));
      }));
      return results;
    },
  };
}

function classifyFacts(identity: ProcessIdentity): ProcessProbeStatus {
  return identity.name && identity.startTimeMs ? 'matched' : 'partial';
}

export function createProcessProbe(options: {
  platform?: NodeJS.Platform;
  lookup?: (pid: number) => Promise<ProcessIdentity | null | ProcessProbeResult>;
} = {}): ProcessProbe {
  const platform = options.platform ?? process.platform;
  const lookup = options.lookup ?? (platform === 'win32' ? lookupWindowsIdentity : lookupPosixIdentity);

  return createMapProcessProbe(async pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'missing' };
    try {
      const found = await lookup(pid);
      if (!found) return { status: 'missing' };
      if ('status' in found && !('pid' in found)) return found;
      const identity = found as ProcessIdentity;
      identity.name = normalizeProcessName(identity.name);
      return { status: classifyFacts(identity), identity };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/denied|eacces|eperm/i.test(message)) return { status: 'denied', error: message };
      if (/timed? ?out/i.test(message)) return { status: 'timeout', error: message };
      return { status: 'ambiguous', error: message };
    }
  });
}

async function lookupWindowsIdentity(pid: number): Promise<ProcessIdentity | null> {
  const { collectBoundedProcess } = await import('../services/bounded-subprocess');
  const { killProcessTree } = await import('../utils');
  const script = [
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + String(pid) + '" -ErrorAction SilentlyContinue;',
    'if (-not $p) { Write-Output \'{"missing":true}\'; exit 0 }',
    '$epoch = [DateTimeOffset]$p.CreationDate;',
    'Write-Output (@{ pid = $p.ProcessId; name = $p.Name; startTimeMs = [int64]($epoch.ToUnixTimeMilliseconds()); parentPid = $p.ParentProcessId } | ConvertTo-Json -Compress)',
  ].join(' ');
  const proc = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command', script], { detached: process.platform !== 'win32',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const result = await collectBoundedProcess(proc, {
    timeoutMs: 3_000,
    maxChars: 16_384,
    label: 'Windows process probe',
    terminate: () => killProcessTree(proc),
  });
  if (result.timedOut) throw new Error('Windows process probe timed out');
  if (result.error) throw new Error(result.error);
  if (result.exitCode !== 0) throw new Error(result.stderr || `powershell exited ${result.exitCode}`);
  const parsed = JSON.parse(result.stdout.trim() || '{}') as Record<string, unknown>;
  if (parsed.missing === true) return null;
  const foundPid = Number(parsed.pid);
  if (!Number.isSafeInteger(foundPid) || foundPid !== pid) return null;
  return {
    pid: foundPid,
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    startTimeMs: Number.isFinite(Number(parsed.startTimeMs)) ? Number(parsed.startTimeMs) : undefined,
    parentPid: Number.isSafeInteger(Number(parsed.parentPid)) ? Number(parsed.parentPid) : undefined,
  };
}

async function lookupPosixIdentity(pid: number): Promise<ProcessIdentity | null> {
  const { collectBoundedProcess } = await import('../services/bounded-subprocess');
  const { killProcessTree } = await import('../utils');
  const proc = Bun.spawn(['ps', '-p', String(pid), '-o', 'pid=,ppid=,lstart=,comm='], { detached: process.platform !== 'win32',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const result = await collectBoundedProcess(proc, {
    timeoutMs: 2_000,
    maxChars: 4_096,
    label: 'POSIX process probe',
    terminate: () => killProcessTree(proc),
  });
  if (result.timedOut) throw new Error('POSIX process probe timed out');
  return interpretPosixPsResult(pid, result);
}

export interface PosixPsResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Returns true when the PID is known not to exist (kill(pid, 0) fails with ESRCH). */
export function posixPidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}

export function interpretPosixPsResult(
  pid: number,
  result: PosixPsResult,
  isGone: (pid: number) => boolean = posixPidIsGone,
): ProcessIdentity | null {
  if (result.exitCode !== 0) {
    if (/no such process|not found/i.test(result.stderr || result.stdout)) return null;
    // procps `ps -p <pid>` exits 1 with no output at all when the PID does not exist.
    // Confirm with kill(pid, 0) so a silent ps failure on a live PID stays ambiguous.
    if (result.exitCode === 1 && !result.stdout.trim() && !result.stderr.trim() && isGone(pid)) return null;
    throw new Error(result.stderr || `ps exited ${result.exitCode}`);
  }
  const line = result.stdout.trim();
  if (!line) return null;
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/);
  if (!match) throw new Error('unparsed ps output');
  const startTimeMs = Date.parse(match[3]!);
  return {
    pid: Number(match[1]),
    parentPid: Number(match[2]),
    startTimeMs: Number.isFinite(startTimeMs) ? startTimeMs : undefined,
    name: match[4],
  };
}
