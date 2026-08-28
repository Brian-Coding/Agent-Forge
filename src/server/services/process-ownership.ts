import { createHash, randomUUID } from 'crypto';
import type { ProcessIdentity, ProcessProbe, ProcessProbeResult } from '../platform/process-probe';
import { normalizeProcessName } from '../platform/process-probe';
import type { TreeKillResult } from '../utils';

export type OwnedProcessKind = 'server' | 'claude' | 'codex' | 'browser-worker' | 'other-owned-child';

export type OwnershipDecisionReason =
  | 'missing'
  | 'owned-match'
  | 'legacy-unverified'
  | 'pid-reused'
  | 'start-time-mismatch'
  | 'nonce-mismatch'
  | 'instance-mismatch'
  | 'facts-unavailable'
  | 'probe-denied'
  | 'probe-timeout'
  | 'probe-ambiguous'
  | 'malformed-record';

export interface OwnedProcessRecordV2 {
  schemaVersion: 2;
  ownerInstanceId: string;
  ownerSessionId: string;
  processId: number;
  processKind: OwnedProcessKind;
  executableBasename: string;
  observedStartTimeMs?: number;
  parentProcessId?: number;
  createdAt: string;
  lastConfirmedAt?: string;
  ownershipNonceHash?: string;
  intendedPort?: number;
}

export interface OwnershipDecision {
  terminate: boolean;
  reason: OwnershipDecisionReason;
}

export const START_TIME_MATCH_TOLERANCE_MS = 15_000;

export function hashOwnershipNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

export function createOwnershipSession(instanceId = defaultInstanceId()): {
  ownerInstanceId: string;
  ownerSessionId: string;
  ownershipNonce: string;
  ownershipNonceHash: string;
} {
  const ownershipNonce = randomUUID();
  return {
    ownerInstanceId: instanceId,
    ownerSessionId: randomUUID(),
    ownershipNonce,
    ownershipNonceHash: hashOwnershipNonce(ownershipNonce),
  };
}

function defaultInstanceId(): string {
  return createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16);
}

export function isOwnedProcessRecord(value: unknown): value is OwnedProcessRecordV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 2
    && typeof record.ownerInstanceId === 'string'
    && typeof record.ownerSessionId === 'string'
    && Number.isSafeInteger(record.processId)
    && (record.processId as number) > 1
    && typeof record.processKind === 'string'
    && typeof record.executableBasename === 'string'
    && typeof record.createdAt === 'string';
}

export function decideOwnership(
  record: OwnedProcessRecordV2 | { processId: number; legacy: true },
  probe: ProcessProbeResult,
  options: { expectedInstanceId?: string; expectedNonceHash?: string } = {},
): OwnershipDecision {
  if ('legacy' in record && record.legacy) {
    return { terminate: false, reason: probe.status === 'missing' ? 'missing' : 'legacy-unverified' };
  }

  if (!isOwnedProcessRecord(record)) return { terminate: false, reason: 'malformed-record' };

  if (probe.status === 'missing') return { terminate: false, reason: 'missing' };
  if (probe.status === 'denied') return { terminate: false, reason: 'probe-denied' };
  if (probe.status === 'timeout') return { terminate: false, reason: 'probe-timeout' };
  if (probe.status === 'ambiguous') return { terminate: false, reason: 'probe-ambiguous' };
  if (probe.status === 'partial' || !probe.identity) return { terminate: false, reason: 'facts-unavailable' };

  const identity = probe.identity;
  if (identity.pid !== record.processId) return { terminate: false, reason: 'pid-reused' };

  const liveName = normalizeProcessName(identity.name);
  const recordedName = normalizeProcessName(record.executableBasename);
  if (liveName && recordedName && liveName !== recordedName) {
    return { terminate: false, reason: 'pid-reused' };
  }

  if (record.observedStartTimeMs && identity.startTimeMs) {
    if (Math.abs(identity.startTimeMs - record.observedStartTimeMs) > START_TIME_MATCH_TOLERANCE_MS) {
      return { terminate: false, reason: 'start-time-mismatch' };
    }
  } else if (record.observedStartTimeMs || identity.startTimeMs) {
    return { terminate: false, reason: 'facts-unavailable' };
  } else {
    return { terminate: false, reason: 'facts-unavailable' };
  }

  if (options.expectedInstanceId && record.ownerInstanceId !== options.expectedInstanceId) {
    return { terminate: false, reason: 'instance-mismatch' };
  }
  if (options.expectedNonceHash && record.ownershipNonceHash && record.ownershipNonceHash !== options.expectedNonceHash) {
    return { terminate: false, reason: 'nonce-mismatch' };
  }

  return { terminate: true, reason: 'owned-match' };
}

export function decidePriorServerHandoff(
  lockStartedAt: string,
  probe: ProcessProbeResult,
): OwnershipDecision {
  if (probe.status === 'missing') return { terminate: false, reason: 'missing' };
  if (probe.status !== 'matched' || !probe.identity) {
    return { terminate: false, reason: probe.status === 'denied' ? 'probe-denied'
      : probe.status === 'timeout' ? 'probe-timeout'
        : probe.status === 'ambiguous' ? 'probe-ambiguous'
          : 'facts-unavailable' };
  }

  const name = normalizeProcessName(probe.identity.name);
  if (name && name !== 'bun') return { terminate: false, reason: 'pid-reused' };
  if (!name || !probe.identity.startTimeMs) return { terminate: false, reason: 'facts-unavailable' };

  const lockStart = Date.parse(lockStartedAt);
  if (!Number.isFinite(lockStart)) return { terminate: false, reason: 'malformed-record' };
  if (Math.abs(probe.identity.startTimeMs - lockStart) > START_TIME_MATCH_TOLERANCE_MS) {
    return { terminate: false, reason: 'start-time-mismatch' };
  }
  return { terminate: true, reason: 'owned-match' };
}

export function recordFromProbe(
  session: { ownerInstanceId: string; ownerSessionId: string; ownershipNonceHash?: string },
  kind: OwnedProcessKind,
  identity: ProcessIdentity,
  extras: Partial<Pick<OwnedProcessRecordV2, 'intendedPort'>> = {},
): OwnedProcessRecordV2 {
  return {
    schemaVersion: 2,
    ownerInstanceId: session.ownerInstanceId,
    ownerSessionId: session.ownerSessionId,
    processId: identity.pid,
    processKind: kind,
    executableBasename: normalizeProcessName(identity.name) ?? 'unknown',
    observedStartTimeMs: identity.startTimeMs,
    parentProcessId: identity.parentPid,
    createdAt: new Date().toISOString(),
    lastConfirmedAt: new Date().toISOString(),
    ownershipNonceHash: session.ownershipNonceHash,
    ...extras,
  };
}

export async function terminateIfOwned(options: {
  record: OwnedProcessRecordV2;
  probe: ProcessProbe;
  killTree: (pid: number) => Promise<TreeKillResult>;
  expectedInstanceId?: string;
}): Promise<{ decision: OwnershipDecision; killed: boolean }> {
  const first = await options.probe.probe(options.record.processId);
  const decision = decideOwnership(options.record, first, { expectedInstanceId: options.expectedInstanceId });
  if (!decision.terminate) return { decision, killed: false };
  const again = await options.probe.probe(options.record.processId);
  const confirmed = decideOwnership(options.record, again, { expectedInstanceId: options.expectedInstanceId });
  if (!confirmed.terminate) return { decision: confirmed, killed: false };
  const result = await options.killTree(options.record.processId);
  return { decision: confirmed, killed: result.succeeded };
}
