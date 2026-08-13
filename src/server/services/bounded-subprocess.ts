import { drainStreamToString } from '../agents/stream-utils';

export interface CollectableProcess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

export interface BoundedProcessOptions {
  timeoutMs: number;
  terminationTimeoutMs?: number;
  maxChars?: number;
  retainOutput?: 'head' | 'tail';
  label?: string;
  terminate(): void | Promise<unknown>;
}

export interface BoundedProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

function bounded(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

async function terminateWithin(operation: () => void | Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve().then(operation).then(() => undefined, () => undefined),
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Drain both pipes concurrently and place a hard ceiling around the process. */
export async function collectBoundedProcess(
  process: CollectableProcess,
  options: BoundedProcessOptions,
): Promise<BoundedProcessResult> {
  const timeoutMs = bounded(options.timeoutMs, 10_000);
  const terminationTimeoutMs = bounded(options.terminationTimeoutMs, 3_000);
  const maxChars = bounded(options.maxChars, 64_000);
  const label = options.label || 'Subprocess';
  const retainOutput = options.retainOutput ?? 'tail';
  const drainAbort = new AbortController();
  const completion = Promise.all([
    process.exited,
    drainStreamToString(process.stdout, maxChars, drainAbort.signal, retainOutput),
    drainStreamToString(process.stderr, maxChars, drainAbort.signal, retainOutput),
  ]);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    const outcome = await Promise.race([completion, deadline]);
    if (outcome === 'timeout') {
      await terminateWithin(options.terminate, terminationTimeoutMs);
      drainAbort.abort(new Error(`${label} timed out`));
      return {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
        error: `${label} timed out after ${timeoutMs}ms`,
      };
    }
    const [exitCode, stdout, stderr] = outcome;
    return { exitCode, stdout, stderr, timedOut: false };
  } catch (error) {
    await terminateWithin(options.terminate, terminationTimeoutMs);
    drainAbort.abort(error);
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
