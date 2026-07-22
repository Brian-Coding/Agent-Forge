import type { QaRunInfo } from '../../shared/protocol';

export function compactQaRunHistory(runs: QaRunInfo[], limit: number): QaRunInfo[] {
  const active = runs.filter(item => item.status === 'queued' || item.status === 'running');
  const terminal = runs.filter(item => item.status !== 'queued' && item.status !== 'running');
  const terminalLimit = Math.max(0, limit - active.length);
  const retainedTerminal = terminalLimit > 0 ? terminal.slice(-terminalLimit) : [];
  const retainedTerminalIds = new Set(retainedTerminal.map(item => item.id));

  // Never evict an in-flight run merely because many requests were queued.
  // Preserve chronological order so persistence and the UI remain predictable.
  return runs.filter(item =>
    item.status === 'queued' || item.status === 'running' || retainedTerminalIds.has(item.id),
  );
}

export function appendQaRunHistory(
  existing: QaRunInfo[],
  run: QaRunInfo,
  limit: number,
): QaRunInfo[] {
  return compactQaRunHistory([...existing, run], limit);
}
