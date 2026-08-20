export interface ShutdownRequest {
  exitCode?: number;
  reason?: string;
  force?: boolean;
}

export interface ShutdownDependencies {
  stopIntake(): void | Promise<void>;
  stopWork(): void | Promise<void>;
  forceStopWork(): void | Promise<void>;
  persistData(): void | Promise<void>;
  persistPids(): void | Promise<void>;
  releaseLock(): void | Promise<void>;
  exit(code: number): void | Promise<void>;
  log?(level: 'info' | 'warn' | 'error', message: string, error?: unknown): void;
}

export interface ShutdownTimeouts {
  stopIntakeMs?: number;
  stopWorkMs?: number;
  forceStopWorkMs?: number;
  persistDataMs?: number;
  persistPidsMs?: number;
  releaseLockMs?: number;
}

type StageResult = { ok: true } | { ok: false; timedOut: boolean; error?: unknown };

function bounded(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

async function runStage(
  label: string,
  timeoutMs: number,
  operation: () => void | Promise<void>,
  log: NonNullable<ShutdownDependencies['log']>,
): Promise<StageResult> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const completion: Promise<StageResult> = Promise.resolve().then(operation).then(
    (): StageResult => ({ ok: true }),
    (error): StageResult => ({ ok: false, timedOut: false, error }),
  );
  const deadline = new Promise<StageResult>(resolve => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
  });
  try {
    const result = await Promise.race([completion, deadline]);
    if (!result.ok) {
      if (result.timedOut) log('warn', `${label} timed out after ${timeoutMs}ms.`);
      else log('error', `${label} failed.`, result.error);
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Build an exactly-once shutdown function. Every stage is independent and
 * bounded so one failed subsystem cannot skip durable-state or lock cleanup.
 */
export function createShutdownCoordinator(
  deps: ShutdownDependencies,
  timeouts: ShutdownTimeouts = {},
): (request?: ShutdownRequest) => Promise<void> {
  const log = deps.log ?? ((level, message, error) => {
    const writer = level === 'info' ? console.log : level === 'warn' ? console.warn : console.error;
    if (error === undefined) writer(message);
    else writer(message, error);
  });
  let shutdownPromise: Promise<void> | null = null;
  let forcePromise: Promise<StageResult> | null = null;
  let desiredExitCode = 0;

  const forceOnce = () => {
    forcePromise ??= runStage(
      'Forced process cleanup',
      bounded(timeouts.forceStopWorkMs, 3_000),
      deps.forceStopWork,
      log,
    );
    return forcePromise;
  };

  return (request: ShutdownRequest = {}) => {
    const requestedCode = Number.isSafeInteger(request.exitCode) && (request.exitCode ?? 0) > 0
      ? Math.floor(request.exitCode!)
      : 0;
    desiredExitCode = Math.max(desiredExitCode, requestedCode);
    if (shutdownPromise) {
      if (request.force) void forceOnce();
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      log('info', request.reason ? `Shutting down: ${request.reason}` : 'Shutting down.');
      await runStage('Stop accepting requests', bounded(timeouts.stopIntakeMs, 1_000), deps.stopIntake, log);
      const stopped = await runStage('Graceful process cleanup', bounded(timeouts.stopWorkMs, 5_000), deps.stopWork, log);
      if (!stopped.ok || request.force) await forceOnce();

      await runStage('Final data persistence', bounded(timeouts.persistDataMs, 2_000), deps.persistData, log);
      // Do not clear the PID set here. Subsystems remove confirmed exits;
      // anything left is deliberately durable for next-start orphan recovery.
      await runStage('Orphan PID persistence', bounded(timeouts.persistPidsMs, 2_000), deps.persistPids, log);
      await runStage('Process-lock release', bounded(timeouts.releaseLockMs, 2_000), deps.releaseLock, log);
      await Promise.resolve().then(() => deps.exit(desiredExitCode));
    })().catch(error => {
      // Stage failures are already contained. This is a final guard for a
      // broken logger or exit dependency; never turn it into an unhandled
      // rejection during fatal-error processing.
      try { console.error('Shutdown coordinator failed:', error); } catch {}
    });
    return shutdownPromise;
  };
}
