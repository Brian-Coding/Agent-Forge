import { open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

let nextTemporaryId = 1;
const targetWriteChains = new Map<string, Promise<void>>();

export type AtomicWritePhase =
  | 'before-open'
  | 'after-open'
  | 'after-write'
  | 'after-sync'
  | 'after-close'
  | 'after-rename';

export interface AtomicWriteOptions {
  mode?: number;
  /** Deterministic failure-injection hook used by reliability tests. */
  onPhase?: (phase: AtomicWritePhase, temporaryPath: string) => void | Promise<void>;
}

function temporaryPathFor(targetPath: string): string {
  const id = nextTemporaryId++;
  return `${targetPath}.${process.pid}.${id}.tmp`;
}

/**
 * Durably replace one file without ever exposing partially-written JSON.
 *
 * The temporary file is written in the destination directory, flushed, closed,
 * and only then renamed over the destination. A failed pre-rename phase leaves
 * the old destination intact. Best-effort temporary cleanup never masks the
 * original error.
 */
async function performAtomicWrite(
  targetPath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const temporaryPath = temporaryPathFor(targetPath);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let renamed = false;

  try {
    await options.onPhase?.('before-open', temporaryPath);
    handle = await open(temporaryPath, 'wx', options.mode ?? 0o600);
    await options.onPhase?.('after-open', temporaryPath);
    await handle.writeFile(content);
    await options.onPhase?.('after-write', temporaryPath);
    await handle.sync();
    await options.onPhase?.('after-sync', temporaryPath);
    await handle.close();
    handle = null;
    await options.onPhase?.('after-close', temporaryPath);
    await rename(temporaryPath, targetPath);
    renamed = true;
    await options.onPhase?.('after-rename', temporaryPath);

    // POSIX needs the containing directory flushed for rename durability.
    // Windows does not allow opening directories this way; its file flush and
    // rename are still the strongest portable primitive available here.
    if (process.platform !== 'win32') {
      let directory: Awaited<ReturnType<typeof open>> | null = null;
      try {
        directory = await open(dirname(targetPath), 'r');
        await directory.sync();
      } finally {
        await directory?.close().catch(() => {});
      }
    }
  } finally {
    await handle?.close().catch(() => {});
    if (!renamed) await unlink(temporaryPath).catch(() => {});
  }
}

/**
 * Serialize replacements of the same destination. Windows can reject two
 * otherwise-valid concurrent renames with EPERM; the queue also guarantees
 * invocation order while leaving writes to independent files concurrent.
 * A rejected write is deliberately caught only for queue progression, so the
 * original caller still receives the failure and later writes can recover.
 */
export function atomicWriteFile(
  targetPath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const resolved = resolve(targetPath);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const preceding = targetWriteChains.get(key) ?? Promise.resolve();
  const operation = preceding
    .catch(() => {})
    .then(() => performAtomicWrite(targetPath, content, options));
  targetWriteChains.set(key, operation);
  return operation.finally(() => {
    if (targetWriteChains.get(key) === operation) targetWriteChains.delete(key);
  });
}
