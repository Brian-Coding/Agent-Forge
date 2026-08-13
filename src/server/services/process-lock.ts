import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { randomUUID } from 'crypto';

export interface ProcessLockOwner {
  pid: number;
  startedAt: string;
  token?: string;
}

export interface ProcessLockHandle {
  path: string;
  owner: Required<ProcessLockOwner>;
}

export type ExistingLockDecision =
  | { action: 'replace'; reason?: string }
  | { action: 'refuse'; reason?: string };

export interface ProcessLockOptions {
  path: string;
  pid?: number;
  token?: string;
  inspectExisting(owner: ProcessLockOwner): ExistingLockDecision | Promise<ExistingLockDecision>;
  isProcessAlive?: (pid: number) => boolean;
  guardWaitMs?: number;
  guardRetryMs?: number;
  guardStaleMs?: number;
}

export class ProcessLockHeldError extends Error {
  constructor(message: string, public readonly owner?: ProcessLockOwner) {
    super(message);
    this.name = 'ProcessLockHeldError';
  }
}

interface OwnerRead {
  raw: string;
  owner: ProcessLockOwner | null;
}

function bounded(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function parseOwner(raw: string): ProcessLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0) return null;
    if (typeof parsed.startedAt !== 'string' || !Number.isFinite(Date.parse(parsed.startedAt))) return null;
    if (parsed.token !== undefined && (typeof parsed.token !== 'string' || !parsed.token)) return null;
    return {
      pid: parsed.pid as number,
      startedAt: parsed.startedAt,
      ...(typeof parsed.token === 'string' ? { token: parsed.token } : {}),
    };
  } catch {
    return null;
  }
}

function readOwner(path: string): OwnerRead | null {
  try {
    const raw = readFileSync(path, 'utf8');
    return { raw, owner: parseOwner(raw) };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function createExclusive(path: string, owner: Required<ProcessLockOwner>): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeSync(fd, JSON.stringify(owner, null, 2));
    fsyncSync(fd);
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
      fd = null;
      try { unlinkSync(path); } catch {}
    }
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function unlinkIfUnchanged(path: string, expectedRaw: string): boolean {
  try {
    if (readFileSync(path, 'utf8') !== expectedRaw) return false;
    unlinkSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to a different user.
    return errorCode(error) === 'EPERM';
  }
}

async function acquireGuard(
  guardPath: string,
  owner: Required<ProcessLockOwner>,
  options: ProcessLockOptions,
): Promise<void> {
  const waitMs = bounded(options.guardWaitMs, 2_000);
  const retryMs = Math.max(1, bounded(options.guardRetryMs, 10));
  const staleMs = bounded(options.guardStaleMs, 5_000);
  const isAlive = options.isProcessAlive ?? processExists;
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      createExclusive(guardPath, owner);
      return;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }

    const existing = readOwner(guardPath);
    if (!existing) continue;
    let ageMs = 0;
    try { ageMs = Math.max(0, Date.now() - statSync(guardPath).mtimeMs); } catch {}
    const stale = ageMs >= staleMs
      && (!existing.owner?.token || !isAlive(existing.owner.pid));
    if (stale && unlinkIfUnchanged(guardPath, existing.raw)) continue;

    if (Date.now() >= deadline) {
      throw new ProcessLockHeldError(
        `Timed out waiting for process-lock acquisition guard ${guardPath}.`,
        existing.owner ?? undefined,
      );
    }
    await new Promise<void>(resolve => setTimeout(resolve, retryMs));
  }
}

function releaseGuard(guardPath: string, owner: Required<ProcessLockOwner>): void {
  const existing = readOwner(guardPath);
  if (existing?.owner?.pid === owner.pid && existing.owner.token === owner.token) {
    unlinkIfUnchanged(guardPath, existing.raw);
  }
}

async function withGuard<T>(
  owner: Required<ProcessLockOwner>,
  options: ProcessLockOptions,
  operation: () => T | Promise<T>,
): Promise<T> {
  const guardPath = `${options.path}.acquire`;
  await acquireGuard(guardPath, owner, options);
  try {
    return await operation();
  } finally {
    releaseGuard(guardPath, owner);
  }
}

/**
 * Acquire a cwd/project-scoped process lock without a check-then-write race.
 * The acquisition guard also prevents an old owner's delayed cleanup from
 * unlinking a replacement owner's newly-created lock.
 */
export async function acquireProcessLockFile(options: ProcessLockOptions): Promise<ProcessLockHandle> {
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process-lock PID: ${pid}`);
  const owner: Required<ProcessLockOwner> = {
    pid,
    startedAt: new Date().toISOString(),
    token: options.token || randomUUID(),
  };

  return withGuard(owner, options, async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        createExclusive(options.path, owner);
        return { path: options.path, owner };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }

      const existing = readOwner(options.path);
      if (!existing) continue;
      const decision = existing.owner
        ? await options.inspectExisting(existing.owner)
        : { action: 'replace' as const, reason: 'malformed lock record' };
      if (decision.action === 'refuse') {
        throw new ProcessLockHeldError(
          decision.reason || `Process lock ${options.path} is already held.`,
          existing.owner ?? undefined,
        );
      }
      unlinkIfUnchanged(options.path, existing.raw);
    }
    throw new ProcessLockHeldError(`Could not acquire process lock ${options.path} after repeated contention.`);
  });
}

/** Release only the exact token acquired by this process. */
export async function releaseProcessLockFile(
  handle: ProcessLockHandle,
  options: Omit<ProcessLockOptions, 'path' | 'pid' | 'token' | 'inspectExisting'> = {},
): Promise<boolean> {
  const lockOptions: ProcessLockOptions = {
    ...options,
    path: handle.path,
    pid: handle.owner.pid,
    token: handle.owner.token,
    inspectExisting: () => ({ action: 'refuse' }),
  };
  return withGuard(handle.owner, lockOptions, () => {
    const existing = readOwner(handle.path);
    if (!existing?.owner
      || existing.owner.pid !== handle.owner.pid
      || existing.owner.token !== handle.owner.token) return false;
    return unlinkIfUnchanged(handle.path, existing.raw);
  });
}

export function processLockExists(path: string): boolean {
  return existsSync(path);
}
