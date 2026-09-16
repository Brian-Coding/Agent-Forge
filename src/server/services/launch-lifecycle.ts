import type { ProcessProbeResult } from '../platform/process-probe';

export function launcherIsGone(initial: ProcessProbeResult, current: ProcessProbeResult): boolean {
  if (current.status === 'missing') return true;
  const before = initial.identity?.startTimeMs;
  const after = current.identity?.startTimeMs;
  return before !== undefined && after !== undefined && before !== after;
}

/** Do not rely on Windows forwarding terminal-close signals to Bun. */
export function monitorLauncher(options: {
  probe(): Promise<ProcessProbeResult>;
  stopRequested(): boolean;
  shutdown(reason: string): void;
  intervalMs?: number;
}): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const initial = await options.probe();
    const tick = async () => {
      if (cancelled) return;
      if (options.stopRequested() || launcherIsGone(initial, await options.probe())) {
        if (!cancelled) options.shutdown('Launching terminal exited or restart requested');
        return;
      }
      if (!cancelled) timer = setTimeout(() => { void tick(); }, options.intervalMs ?? 1_000);
    };
    await tick();
  };
  void run();
  return () => { cancelled = true; if (timer) clearTimeout(timer); };
}
