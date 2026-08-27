import type { ExistingLockDecision, ProcessLockOwner } from './services/process-lock';
import { processExists } from './services/process-lock';
import type { ProcessProbe } from './platform/process-probe';
import { decidePriorServerHandoff } from './services/process-ownership';

export interface StartupLockInspectionDeps {
  probe: ProcessProbe;
  isImmediateAncestor(pid: number): boolean;
  requestGracefulExit(pid: number): void;
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
  now?: () => number;
}

const GRACEFUL_HANDOFF_MS = 4_000;

export async function inspectExistingServerLock(
  owner: ProcessLockOwner,
  deps: StartupLockInspectionDeps,
): Promise<ExistingLockDecision> {
  if (owner.pid === process.pid) {
    return { action: 'replace', reason: 'same-process legacy lock' };
  }
  if (deps.isImmediateAncestor(owner.pid)) {
    return {
      action: 'refuse',
      reason:
        `Refusing to start: agent-forge.lock is owned by our ancestor process (PID ${owner.pid}). ` +
        'An agent inside a running Agent Forge may have tried to start another server.',
    };
  }

  const probe = await deps.probe.probe(owner.pid);
  if (probe.status === 'missing') {
    return { action: 'replace', reason: `Stale agent-forge.lock (PID ${owner.pid} no longer running)` };
  }

  const handoff = decidePriorServerHandoff(owner.startedAt, probe);
  if (!handoff.terminate) {
    if (handoff.reason === 'pid-reused') {
      return {
        action: 'replace',
        reason: `Stale agent-forge.lock (PID ${owner.pid} is no longer the recorded Bun server)`,
      };
    }
    return {
      action: 'refuse',
      reason:
        `Refusing to start: PID ${owner.pid} is live but ownership is ${handoff.reason}. ` +
        'Stop that process yourself or remove agent-forge.lock. Agent Forge will not kill an unproven process.',
    };
  }

  deps.requestGracefulExit(owner.pid);
  const exited = await deps.waitForExit(owner.pid, GRACEFUL_HANDOFF_MS);
  if (exited) {
    return { action: 'replace', reason: `Previous Agent Forge PID ${owner.pid} exited after graceful handoff` };
  }
  return {
    action: 'refuse',
    reason:
      `Refusing to start: previous Agent Forge PID ${owner.pid} did not exit after graceful handoff. ` +
      'Unsafe force-kill is disabled. Stop that process and retry.',
  };
}

export async function waitUntilProcessMissing(
  pid: number,
  timeoutMs: number,
  probe: ProcessProbe,
  exists: (pid: number) => boolean = processExists,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe.probe(pid);
    if (result.status === 'missing' && !exists(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const last = await probe.probe(pid);
  return last.status === 'missing' && !exists(pid);
}

export function reportOccupiedPorts(
  netstatOut: string,
  rangeStart: number,
  rangeEnd: number,
  ourPid: number,
): number[] {
  const occupants = new Set<number>();
  for (const line of netstatOut.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
    const m = parts[1]!.match(/:(\d+)$/);
    if (!m) continue;
    const port = parseInt(m[1]!, 10);
    if (port < rangeStart || port > rangeEnd) continue;
    const pid = parseInt(parts[4]!, 10);
    if (!Number.isFinite(pid) || pid === 0 || pid === ourPid) continue;
    occupants.add(pid);
  }
  return [...occupants];
}
