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

// Kill an entire process tree. Windows needs taskkill /T; POSIX gets a direct
// process kill fallback because spawned CLIs are not always in their own group.
export async function treeKill(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      const proc = Bun.spawn(['taskkill', '/T', '/F', '/PID', String(pid)], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;
      return;
    }

    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  } catch (e) {
    console.error(`treeKill(${pid}) failed (process may already be dead):`, e);
  }
}

// Kill a Bun Subprocess's entire process tree, falling back to .kill() if no PID
export async function killProcessTree(proc: Subprocess<any, any, any>): Promise<void> {
  if (proc.pid) {
    await treeKill(proc.pid);
  } else {
    try { proc.kill(); } catch {}
  }
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
import { join as _pathJoin } from 'path';

const _binaryCache: Map<string, string> = (globalThis as any).__cliBinaryCache ??= new Map<string, string>();

function _pathDelimiter(isWin: boolean): string {
  return isWin ? ';' : ':';
}

function _defaultCliDirs(isWin: boolean): string[] {
  if (isWin) return [];

  const home = _homedir();
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

function _cliSearchDirs(): string[] {
  const isWin = process.platform === 'win32';
  const pathRaw = process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathRaw.split(_pathDelimiter(isWin)).filter(Boolean);
  const seen = new Set<string>();

  return dirs.concat(_defaultCliDirs(isWin)).filter((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
}

/**
 * Build an environment for spawned agent CLIs.
 *
 * GUI-launched shells and editor tasks on macOS often start Bun with a minimal
 * PATH that omits Homebrew and ~/.local/bin. Resolve/spawn use the same
 * augmented PATH so absolute shim scripts can still find `node` and helper
 * binaries through `/usr/bin/env`.
 */
export function createCliEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const isWin = process.platform === 'win32';
  const env: Record<string, string> = {};

  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE') continue;
    if (k === '__CFBundleIdentifier') continue;
    if (k === 'INIT_CWD' || k === 'NODE' || k === 'TERM_PROGRAM' || k === 'TERM_PROGRAM_VERSION') continue;
    if (k.startsWith('VSCODE_') || k.startsWith('npm_')) continue;
    if (typeof v === 'string') env[k] = v;
  }

  const pathKey = isWin ? (env.Path !== undefined ? 'Path' : 'PATH') : 'PATH';
  env[pathKey] = _cliSearchDirs().join(_pathDelimiter(isWin));

  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'string') env[k] = v;
  }

  return env;
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
