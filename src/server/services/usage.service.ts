import type { AgentProvider, UsageBucket, UsageEvent, UsageSummary } from '../../shared/protocol';
import { broadcast } from '../broadcast';
import { persistenceService } from './persistence.service';

// HMR-safe state. The log is append-only; the array can grow to thousands of
// rows over time but each row is small (~150 bytes), so ~1MB / ~10K turns.
const events: UsageEvent[] = (globalThis as any).__usageEvents ??= [];

const ROLLING_WINDOW_DAYS = 30;

function emptyBucket(): UsageBucket {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 };
}

function addInto(bucket: UsageBucket, ev: UsageEvent): void {
  bucket.inputTokens += ev.inputTokens;
  bucket.outputTokens += ev.outputTokens;
  bucket.costUsd += ev.costUsd;
  bucket.turns += ev.turns;
}

function emptySummary(windowDays: number): UsageSummary {
  return {
    windowDays,
    claude: emptyBucket(),
    codex: emptyBucket(),
    total: emptyBucket(),
  };
}

/**
 * Compute a rollup over the entire log (windowDays = 0) or just the entries
 * within the given trailing window (e.g. last 30 days). The window is
 * exclusive-of-future, inclusive-of-now: an event with `timestamp` equal to
 * "now minus windowDays" is included.
 */
function computeSummary(windowDays: number = 0): UsageSummary {
  const summary = emptySummary(windowDays);
  const cutoff = windowDays > 0 ? Date.now() - windowDays * 24 * 60 * 60 * 1000 : -Infinity;
  for (const ev of events) {
    if (ev.timestamp < cutoff) continue;
    if (ev.provider === 'claude') addInto(summary.claude, ev);
    else if (ev.provider === 'codex') addInto(summary.codex, ev);
    addInto(summary.total, ev);
  }
  return summary;
}

/**
 * Send the latest rolling + lifetime summaries to all connected clients.
 * Called after each turn-finalize and on initial WS connect.
 */
function broadcastSummary(): void {
  broadcast({
    type: 'usage_summary',
    rolling: computeSummary(ROLLING_WINDOW_DAYS),
    lifetime: computeSummary(0),
  });
}

export const usageService = {
  /** Restore the log from persistence on startup. Idempotent + safe to call before any other init. */
  load(persisted: UsageEvent[] | undefined): void {
    events.length = 0;
    if (Array.isArray(persisted)) {
      for (const ev of persisted) {
        // Defensive: only accept entries we recognize. Forward-compat ignores
        // unknown providers / missing fields without throwing on load.
        if (
          ev && typeof ev === 'object'
          && typeof ev.timestamp === 'number'
          && typeof ev.agentId === 'string'
          && (ev.provider === 'claude' || ev.provider === 'codex')
        ) {
          events.push({
            timestamp: ev.timestamp,
            agentId: ev.agentId,
            provider: ev.provider,
            inputTokens: typeof ev.inputTokens === 'number' ? ev.inputTokens : 0,
            outputTokens: typeof ev.outputTokens === 'number' ? ev.outputTokens : 0,
            costUsd: typeof ev.costUsd === 'number' ? ev.costUsd : 0,
            turns: typeof ev.turns === 'number' ? ev.turns : 0,
          });
        }
      }
    }
  },

  /**
   * Append a turn's coalesced usage to the log. No-op if every field is zero
   * (a turn that ran but produced no measurable usage — empty turn, error,
   * stopped before any API call). Triggers a save + broadcast.
   */
  record(agentId: string, provider: AgentProvider, deltas: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    turns?: number;
  }): void {
    const inputTokens = Math.max(0, deltas.inputTokens ?? 0);
    const outputTokens = Math.max(0, deltas.outputTokens ?? 0);
    const costUsd = Math.max(0, deltas.costUsd ?? 0);
    const turns = Math.max(0, deltas.turns ?? 0);
    if (inputTokens === 0 && outputTokens === 0 && costUsd === 0 && turns === 0) return;
    events.push({
      timestamp: Date.now(),
      agentId,
      provider,
      inputTokens,
      outputTokens,
      costUsd,
      turns,
    });
    persistenceService.save();
    broadcastSummary();
  },

  /** Snapshot the current log for persistence. */
  getEvents(): UsageEvent[] {
    return events;
  },

  /** Build the rolling + lifetime summaries — used by ws.ts on WS connect. */
  getSummariesForConnect(): { rolling: UsageSummary; lifetime: UsageSummary } {
    return {
      rolling: computeSummary(ROLLING_WINDOW_DAYS),
      lifetime: computeSummary(0),
    };
  },
};
