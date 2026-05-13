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
export function safeSpawn(
  args: string[],
  opts: SpawnOptions.OptionsObject<'pipe', 'pipe', 'pipe'>,
): Subprocess<'pipe', 'pipe', 'pipe'> {
  const bytes = estimateArgvBytes(args);
  if (bytes > MAX_ARGV_BYTES) {
    throw new ArgvTooLongError(bytes, MAX_ARGV_BYTES, args[0] ?? 'unknown');
  }
  return Bun.spawn(args, opts) as Subprocess<'pipe', 'pipe', 'pipe'>;
}

export function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Kill an entire process tree on Windows using taskkill /T /F
export async function treeKill(pid: number): Promise<void> {
  try {
    const proc = Bun.spawn(['taskkill', '/T', '/F', '/PID', String(pid)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
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
