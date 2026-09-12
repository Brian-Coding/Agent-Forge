import type { Subprocess, SpawnOptions } from 'bun';

export function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// --- Argv-length guard ------------------------------------------------------
// Windows CreateProcess refuses command lines past ~32K bytes. Above the
// limit, Bun's native spawn wrapper has been observed to crash the entire
// server (not throw a JS error we can catch). We pre-check the serialized
// argv size and throw a catchable ArgvTooLongError so the chat surfaces a
// human-readable message instead of orphaning port 3333 and forcing a reboot.

const MAX_ARGV_BYTES = 28_000;

export class ArgvTooLongError extends Error {
  constructor(
    public readonly totalBytes: number,
    public readonly limit: number,
    public readonly executable: string,
  ) {
    super(
      `Refusing to spawn ${executable}: argv would be ${totalBytes} bytes ` +
      `(limit ${limit}). Windows CreateProcess caps the command line at ~32K; ` +
      `exceeding it crashes the server. Move large content (system prompts, ` +
      `prompts, file lists) to stdin or a temp file.`,
    );
    this.name = 'ArgvTooLongError';
  }
}

// Approximate the serialized command-line bytes Windows will build. The
// real algorithm in CommandLineToArgvW is fiddly (quote/backslash escaping),
// so we overestimate: each arg's UTF-8 length plus 3 bytes for the
// surrounding `"` chars and the trailing separator space. This lands well
// under 32K with the 28K cap.
function estimateArgvBytes(args: string[]): number {
  let total = 0;
  for (const arg of args) total += Buffer.byteLength(arg, 'utf8') + 3;
  return total;
}

// Spawn wrapper that enforces the argv-size guard BEFORE calling Bun.spawn.
// Every long-running child (claude, codex, terminal sessions that pass large
// payloads) should go through this so a pathological prompt or doc-heavy
// system context cannot panic the host process.
// Throw a catchable ArgvTooLongError if the serialized argv would exceed the
// Windows command-line limit. Call this before any raw Bun.spawn whose stdio
// shape differs from safeSpawn's pipe/pipe/pipe (e.g. terminal sessions).
export function assertArgvWithinLimit(args: string[]): void {
  const bytes = estimateArgvBytes(args);
  if (bytes > MAX_ARGV_BYTES) {
    throw new ArgvTooLongError(bytes, MAX_ARGV_BYTES, args[0] ?? 'unknown');
  }
}

export function safeSpawn(
  args: string[],
  opts: SpawnOptions.OptionsObject<'pipe', 'pipe', 'pipe'>,
): Subprocess<'pipe', 'pipe', 'pipe'> {
  assertArgvWithinLimit(args);
  return Bun.spawn(args, opts) as Subprocess<'pipe', 'pipe', 'pipe'>;
}

export function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// --- Bounded process-tree termination --------------------------------------

const DEFAULT_TASKKILL_TIMEOUT_MS = 1_500;
const DEFAULT_ROOT_EXIT_GRACE_MS = 500;
const DEFAULT_FINAL_EXIT_GRACE_MS = 500;

export interface ProcessTerminationOptions {
  taskkillTimeoutMs?: number;
  rootExitGraceMs?: number;
  finalExitGraceMs?: number;
}

export interface ProcessExitWaitResult {
  status: 'exited' | 'timed-out' | 'error';
  exitCode?: number;
  error?: unknown;
}

export interface WaitableKillProcess {
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  unref(): void;
}

export interface ProcessTerminationDependencies {
  readonly platform: NodeJS.Platform;
  spawnTaskkill(pid: number): WaitableKillProcess;
  waitForExit(proc: Pick<WaitableKillProcess, 'exited'>, timeoutMs: number): Promise<ProcessExitWaitResult>;
}

export interface TreeKillResult {
  attempted: boolean;
  succeeded: boolean;
  exitCode: number | null;
  timedOut: boolean;
  error?: string;
}

export interface ProcessTerminationResult {
  rootExited: boolean;
  exitCode: number | null;
  treeKill: TreeKillResult;
  directKillAttempted: boolean;
  directKillError?: string;
  detached: boolean;
  unrefError?: string;
}

export interface ProcessUnwindSignal {
  readonly promise: Promise<void>;
  trigger(): void;
  isTriggered(): boolean;
}

export type OperationOrUnwind<T> =
  | { status: 'completed'; value: T }
  | { status: 'unwound' };

/**
 * Lets an adapter stop awaiting subprocess streams when OS-level termination
 * could not be confirmed. The process PID remains tracked for startup cleanup,
 * but the chat turn can finish with an explicit warning instead of wedging its
 * entire per-agent send queue forever.
 */
export function createProcessUnwindSignal(): ProcessUnwindSignal {
  let triggered = false;
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return {
    promise,
    trigger() {
      if (triggered) return;
      triggered = true;
      resolve();
    },
    isTriggered() {
      return triggered;
    },
  };
}

export async function waitForOperationOrUnwind<T>(
  operation: Promise<T>,
  signal: ProcessUnwindSignal,
): Promise<OperationOrUnwind<T>> {
  if (signal.isTriggered()) return { status: 'unwound' };
  return Promise.race([
    operation.then(value => ({ status: 'completed' as const, value })),
    signal.promise.then(() => ({ status: 'unwound' as const })),
  ]);
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function waitForProcessExit(
  proc: Pick<WaitableKillProcess, 'exited'>,
  timeoutMs: number,
): Promise<ProcessExitWaitResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<ProcessExitWaitResult>(resolve => {
    timer = setTimeout(() => resolve({ status: 'timed-out' }), timeoutMs);
  });
  try {
    return await Promise.race([
      proc.exited.then<ProcessExitWaitResult, ProcessExitWaitResult>(
        exitCode => ({ status: 'exited', exitCode }),
        error => ({ status: 'error', error }),
      ),
      timeout,
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

const defaultProcessTerminationDependencies: ProcessTerminationDependencies = {
  platform: process.platform,
  spawnTaskkill(pid) {
    // Do not pipe taskkill output: an unread pipe can itself become another
    // unbounded wait. The exit code is the authoritative success signal.
    return Bun.spawn(['taskkill', '/T', '/F', '/PID', String(pid)], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      windowsHide: true,
    }) as WaitableKillProcess;
  },
  waitForExit: waitForProcessExit,
};

function skippedTreeKill(error?: string): TreeKillResult {
  return {
    attempted: false,
    succeeded: false,
    exitCode: null,
    timedOut: false,
    ...(error ? { error } : {}),
  };
}

// Kill an entire process tree. Windows needs taskkill /T; POSIX gets a direct
// process kill fallback because spawned CLIs are not always in their own group.
// The optional dependency argument keeps timeout/failure behavior deterministic
// in unit tests while preserving the existing one-argument call surface.
export async function treeKill(
  pid: number,
  options: ProcessTerminationOptions = {},
  deps: ProcessTerminationDependencies = defaultProcessTerminationDependencies,
): Promise<TreeKillResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return skippedTreeKill(`Invalid process id: ${pid}`);
  }

  if (deps.platform === 'win32') {
    let killer: WaitableKillProcess;
    try {
      killer = deps.spawnTaskkill(pid);
    } catch (error) {
      const message = errorText(error);
      console.error(`treeKill(${pid}) could not start taskkill:`, error);
      return { attempted: true, succeeded: false, exitCode: null, timedOut: false, error: message };
    }

    const timeoutMs = boundedTimeout(options.taskkillTimeoutMs, DEFAULT_TASKKILL_TIMEOUT_MS);
    const outcome = await deps.waitForExit(killer, timeoutMs);
    if (outcome.status === 'exited') {
      const exitCode = outcome.exitCode ?? -1;
      return {
        attempted: true,
        succeeded: exitCode === 0,
        exitCode,
        timedOut: false,
        ...(exitCode === 0 ? {} : { error: `taskkill exited with code ${exitCode}` }),
      };
    }

    // taskkill itself is not allowed to wedge shutdown or an agent queue.
    try { killer.kill('SIGKILL'); } catch {}
    try { killer.unref(); } catch {}
    const message = outcome.status === 'error'
      ? `taskkill exit wait failed: ${errorText(outcome.error)}`
      : `taskkill did not exit within ${timeoutMs}ms`;
    console.error(`treeKill(${pid}) failed: ${message}`);
    return {
      attempted: true,
      succeeded: false,
      exitCode: null,
      timedOut: outcome.status === 'timed-out',
      error: message,
    };
  }

  try {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
    return { attempted: true, succeeded: true, exitCode: null, timedOut: false };
  } catch (error) {
    const message = errorText(error);
    console.error(`treeKill(${pid}) failed (process may already be dead):`, error);
    return { attempted: true, succeeded: false, exitCode: null, timedOut: false, error: message };
  }
}

// Kill a Bun Subprocess's tree, verify that its root exited, and fall back to
// a direct kill when taskkill fails. Every wait is capped. If even the direct
// kill cannot be confirmed, detach the handle so it cannot keep Bun alive.
// Existing callers may continue to ignore the returned diagnostic result.
export async function killProcessTree(
  proc: Subprocess<any, any, any>,
  options: ProcessTerminationOptions = {},
  deps: ProcessTerminationDependencies = defaultProcessTerminationDependencies,
): Promise<ProcessTerminationResult> {
  const emptyTreeResult = skippedTreeKill();
  if (proc.exitCode != null || proc.signalCode != null) {
    return {
      rootExited: true,
      exitCode: proc.exitCode,
      treeKill: emptyTreeResult,
      directKillAttempted: false,
      detached: false,
    };
  }

  const treeResult = proc.pid
    ? await treeKill(proc.pid, options, deps)
    : skippedTreeKill('Subprocess has no process id');
  const rootExitGraceMs = treeResult.succeeded
    ? boundedTimeout(options.rootExitGraceMs, DEFAULT_ROOT_EXIT_GRACE_MS)
    : 0;
  const afterTreeKill = await deps.waitForExit(proc, rootExitGraceMs);
  if (afterTreeKill.status === 'exited') {
    return {
      rootExited: true,
      exitCode: afterTreeKill.exitCode ?? null,
      treeKill: treeResult,
      directKillAttempted: false,
      detached: false,
    };
  }

  let directKillError: string | undefined;
  try {
    proc.kill('SIGKILL');
  } catch (error) {
    directKillError = errorText(error);
  }

  const finalExitGraceMs = boundedTimeout(options.finalExitGraceMs, DEFAULT_FINAL_EXIT_GRACE_MS);
  const afterDirectKill = await deps.waitForExit(proc, finalExitGraceMs);
  if (afterDirectKill.status === 'exited') {
    return {
      rootExited: true,
      exitCode: afterDirectKill.exitCode ?? null,
      treeKill: treeResult,
      directKillAttempted: true,
      ...(directKillError ? { directKillError } : {}),
      detached: false,
    };
  }

  let unrefError: string | undefined;
  try {
    proc.unref();
  } catch (error) {
    unrefError = errorText(error);
  }
  return {
    rootExited: false,
    exitCode: null,
    treeKill: treeResult,
    directKillAttempted: true,
    ...(directKillError ? { directKillError } : {}),
    detached: true,
    ...(unrefError ? { unrefError } : {}),
  };
}

// --- CLI binary resolution -------------------------------------------------
// Bun.spawn(['codex', ...]) on Windows fails with ENOENT when spawning from
// cwds other than the one Bun was started in, because Bun's child-spawn path
// doesn't probe PATHEXT the way the parent process does. We resolve the
// absolute path to the shim file ourselves so spawning is path-explicit and
// cwd-independent.
//
// Strategy:
//   * Walk PATH directories
//   * For each dir, look for `<name><ext>` across PATHEXT (or .cmd/.exe/.bat
//     defaults on Windows; bare name on POSIX)
//   * Return the first hit; fall back to the bare name on miss so callers
//     still get a clean ENOENT instead of a runtime crash
//   * Cache per-name forever — npm/bun bin paths don't move during a run

import { existsSync as _existsSync } from 'fs';
import { homedir as _homedir } from 'os';
import { join as _pathJoin, win32 as _pathWin32 } from 'path';

const _binaryCache: Map<string, string> = (globalThis as any).__cliBinaryCache ??= new Map<string, string>();

function _pathDelimiter(isWin: boolean): string {
  return isWin ? ';' : ':';
}

export function defaultCliDirs(platform = process.platform, home = _homedir()): string[] {
  if (platform === 'win32') {
    return [
      _pathWin32.join(home, '.local', 'bin'),
      _pathWin32.join(home, '.bun', 'bin'),
    ];
  }

  return [
    _pathJoin(home, '.local', 'bin'),
    _pathJoin(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
}

function _cliSearchDirsFrom(
  sourceEnv: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  home = _homedir(),
): string[] {
  const isWin = platform === 'win32';
  const pathRaw = sourceEnv.PATH ?? sourceEnv.Path
    ?? Object.entries(sourceEnv).find(([key]) => key.toLowerCase() === 'path')?.[1]
    ?? '';
  const dirs = pathRaw.split(_pathDelimiter(isWin)).filter(Boolean);
  const seen = new Set<string>();

  // Prefer user-owned installers over inherited system PATH entries. A GUI or
  // long-running server can otherwise keep selecting an older global CLI even
  // after the current user installs an update under ~/.local or ~/.bun.
  return defaultCliDirs(platform, home).concat(dirs).filter((dir) => {
    const key = isWin ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function _cliSearchDirs(): string[] {
  return _cliSearchDirsFrom(process.env, process.platform);
}

function omitCliEnvironmentKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === 'claudecode'
    || normalized === '__cfbundleidentifier'
    || normalized === 'init_cwd'
    || normalized === 'node'
    || normalized === 'term_program'
    || normalized === 'term_program_version'
    || normalized === 'path'
    || normalized.startsWith('vscode_')
    || normalized.startsWith('npm_');
}

/**
 * Build an environment for spawned agent CLIs.
 *
 * Long-running and GUI-launched processes can retain a minimal or stale PATH
 * that omits user-local installers. Resolve/spawn use the same augmented PATH
 * so newly installed CLIs and absolute shim scripts can find their helpers.
 */
export function buildCliEnv(
  sourceEnv: Record<string, string | undefined>,
  extra: Record<string, string | undefined> = {},
  platform: NodeJS.Platform = process.platform,
  home = _homedir(),
): Record<string, string> {
  const isWin = platform === 'win32';
  const env: Record<string, string> = {};

  for (const [k, v] of Object.entries(sourceEnv)) {
    if (omitCliEnvironmentKey(k)) continue;
    if (typeof v === 'string') env[k] = v;
  }

  const pathKey = isWin && sourceEnv.Path !== undefined && sourceEnv.PATH === undefined ? 'Path' : 'PATH';
  env[pathKey] = _cliSearchDirsFrom(sourceEnv, platform, home).join(_pathDelimiter(isWin));

  for (const [k, v] of Object.entries(extra)) {
    if (!omitCliEnvironmentKey(k) && typeof v === 'string') env[k] = v;
  }

  return env;
}

export function createCliEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return buildCliEnv(process.env, extra, process.platform);
}

export function resolveCliBinary(name: string): string {
  const cached = _binaryCache.get(name);
  if (cached) return cached;

  const isWin = process.platform === 'win32';

  // Determine which extensions to probe. PATHEXT is uppercase on Windows
  // (e.g. ".COM;.EXE;.BAT;.CMD"); also fold in .CMD/.BAT/.EXE in case PATHEXT
  // is unusual. On POSIX we look for the bare name only.
  const exts: string[] = isWin
    ? Array.from(new Set(
        ((process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
          .filter(Boolean)
          .map(e => e.toLowerCase()))
          .concat(['.cmd', '.bat', '.exe'])
      ))
    : [''];

  for (const dir of _cliSearchDirs()) {
    for (const ext of exts) {
      const candidate = _pathJoin(dir, name + ext);
      try {
        if (_existsSync(candidate)) {
          _binaryCache.set(name, candidate);
          return candidate;
        }
      } catch {
        // permission or weird path — keep going
      }
    }
  }

  // Fallback: bare name. Bun.spawn will surface its own ENOENT with the
  // original argv if this turns out not to be on PATH after all.
  console.warn(`[resolveCliBinary] '${name}' not found on PATH; falling back to bare name`);
  _binaryCache.set(name, name);
  return name;
}

// --- Claude OAuth credentials ----------------------------------------------
// Claude Code persists its subscription OAuth tokens in `~/.claude/.credentials.json`
// and refreshes them in place. Two subsystems need to read that file — the
// limits service (to authenticate the usage endpoint) and the Claude adapter
// (to pre-flight auth before spawning a turn) — so the accessor lives here
// instead of being duplicated in both.
//
// Why the adapter cares: `claude auth status` reports `loggedIn: true` from the
// stored login alone; it says nothing about whether the *access* token is still
// fresh. A turn spawned with an expired access token fails with
// `401 OAuth access token has expired` and exits 1 with no stderr, which used
// to surface as the misleading "Claude CLI exited with code 1 and no output".

export interface ClaudeCredentialState {
  accessToken: string | null;
  subscriptionType: string | null;
  /** Epoch ms when the access token expires; null when the field is absent. */
  expiresAt: number | null;
  /** Epoch ms when the refresh token expires; null when the field is absent. */
  refreshTokenExpiresAt: number | null;
}

/** Treat a token expiring within this window as already expired — the CLI needs
 *  a moment to refresh, and a turn spawned inside it races the rotation. */
export const CLAUDE_TOKEN_EXPIRY_MARGIN_MS = 60_000;

export function claudeCredentialsPath(): string {
  return process.env.AI_HARNESS_CLAUDE_CREDENTIALS_JSON
    || _pathJoin(_homedir(), '.claude', '.credentials.json');
}

function toEpochMsField(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

/** Read Claude Code's stored OAuth state. Returns null when the file is
 *  missing or unreadable — callers treat that as "no first-party login". */
export async function readClaudeCredentialState(): Promise<ClaudeCredentialState | null> {
  try {
    const file = Bun.file(claudeCredentialsPath());
    if (!(await file.exists())) return null;
    const data = JSON.parse(await file.text());
    const oa = data?.claudeAiOauth ?? data?.oauth ?? {};
    const accessToken = oa.accessToken ?? oa.access_token;
    return {
      accessToken: typeof accessToken === 'string' && accessToken ? accessToken : null,
      subscriptionType: typeof oa.subscriptionType === 'string' ? oa.subscriptionType : null,
      expiresAt: toEpochMsField(oa.expiresAt ?? oa.expires_at),
      refreshTokenExpiresAt: toEpochMsField(oa.refreshTokenExpiresAt ?? oa.refresh_token_expires_at),
    };
  } catch {
    return null;
  }
}

/** True when the access token is expired (or about to be). Unknown expiry is
 *  reported as not-expired: absent metadata must never block a working login. */
export function isClaudeAccessTokenExpired(
  creds: ClaudeCredentialState | null,
  nowMs = Date.now(),
  marginMs = CLAUDE_TOKEN_EXPIRY_MARGIN_MS,
): boolean {
  if (!creds || creds.expiresAt === null) return false;
  return nowMs >= creds.expiresAt - marginMs;
}

/** True when the refresh token itself has expired — the CLI cannot recover
 *  from this on its own, so it is the one auth state worth blocking a spawn for. */
export function isClaudeRefreshTokenExpired(
  creds: ClaudeCredentialState | null,
  nowMs = Date.now(),
): boolean {
  if (!creds || creds.refreshTokenExpiresAt === null) return false;
  return nowMs >= creds.refreshTokenExpiresAt;
}
