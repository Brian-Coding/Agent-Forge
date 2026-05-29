import type {
  AgentProvider,
  ProviderTokenBucket,
  UsageEvent,
  UsageReport,
  WindowTokenSummary,
} from '../../shared/protocol';
import { broadcast } from '../broadcast';
import { agentService } from './agent.service';
import { persistenceService } from './persistence.service';

// HMR-safe append-only log. One row per finalized turn (~150 bytes); for a heavy
// user that's still under ~10MB after years of use, comfortably small for data.json.
const events: UsageEvent[] = (globalThis as any).__usageEvents ??= [];

// ---------------------------------------------------------------------------
// Bucket / summary helpers
// ---------------------------------------------------------------------------

function emptyBucket(): ProviderTokenBucket {
  return { inputTokens: 0, outputTokens: 0, turns: 0 };
}

function emptyWindow(): WindowTokenSummary {
  return { claude: emptyBucket(), codex: emptyBucket(), total: emptyBucket() };
}

function addInto(bucket: ProviderTokenBucket, ev: UsageEvent): void {
  bucket.inputTokens += ev.inputTokens;
  bucket.outputTokens += ev.outputTokens;
  bucket.turns += ev.turns;
}

function addEventToWindow(window: WindowTokenSummary, ev: UsageEvent): void {
  if (ev.provider === 'claude') addInto(window.claude, ev);
  else if (ev.provider === 'codex') addInto(window.codex, ev);
  addInto(window.total, ev);
}

// ---------------------------------------------------------------------------
// Calendar boundaries (server-local time — server runs on the user's machine
// so this matches the user's clock)
// ---------------------------------------------------------------------------

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Most recent Monday 00:00 local. Monday-as-week-start is what most calendars use in the UK/EU; if the user is US/Sunday-start we can revisit. */
function startOfWeekMs(): number {
  const d = new Date();
  const day = d.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  // Days back to Monday: if today=Mon (1), back 0. if today=Sun (0), back 6. Otherwise day-1.
  const back = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - back);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonthMs(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Report compute
// ---------------------------------------------------------------------------

function computeReport(): UsageReport {
  const today = emptyWindow();
  const week = emptyWindow();
  const month = emptyWindow();
  const allTime = emptyWindow();

  const todayBoundary = startOfTodayMs();
  const weekBoundary = startOfWeekMs();
  const monthBoundary = startOfMonthMs();

  // Per-agent tally, keyed by agentId. Accumulated in one pass.
  const perAgentMap = new Map<string, {
    claude: ProviderTokenBucket;
    codex: ProviderTokenBucket;
    lastTimestamp: number;
  }>();

  for (const ev of events) {
    // Per-window accumulation
    addEventToWindow(allTime, ev);
    if (ev.timestamp >= monthBoundary) addEventToWindow(month, ev);
    if (ev.timestamp >= weekBoundary) addEventToWindow(week, ev);
    if (ev.timestamp >= todayBoundary) addEventToWindow(today, ev);

    // Per-agent accumulation
    let bucket = perAgentMap.get(ev.agentId);
    if (!bucket) {
      bucket = { claude: emptyBucket(), codex: emptyBucket(), lastTimestamp: 0 };
      perAgentMap.set(ev.agentId, bucket);
    }
    if (ev.provider === 'claude') addInto(bucket.claude, ev);
    else if (ev.provider === 'codex') addInto(bucket.codex, ev);
    if (ev.timestamp > bucket.lastTimestamp) bucket.lastTimestamp = ev.timestamp;
  }

  const perAgent = Array.from(perAgentMap.entries())
    .map(([agentId, b]) => ({
      agentId,
      agentName: agentService.getAgentName(agentId),
      claude: b.claude,
      codex: b.codex,
      lastTimestamp: b.lastTimestamp,
    }))
    // Most-recently-used agents first
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  return { today, week, month, allTime, perAgent };
}

function broadcastReport(): void {
  broadcast({ type: 'usage_report', report: computeReport() });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const usageService = {
  /** Restore the log from persistence on startup. Idempotent + safe to call before any other init. */
  load(persisted: UsageEvent[] | undefined): void {
    events.length = 0;
    if (Array.isArray(persisted)) {
      for (const ev of persisted) {
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
            // costUsd remains persisted (some Anthropic data) but is no longer
            // surfaced to the UI. Keeping it preserves a future option to
            // expose authoritative Claude-side cost again if pricing access
            // ever stabilizes upstream.
            costUsd: typeof ev.costUsd === 'number' ? ev.costUsd : 0,
            turns: typeof ev.turns === 'number' ? ev.turns : 0,
          });
        }
      }
    }
  },

  /**
   * Append a turn's coalesced usage to the log. No-op when all counters are
   * zero. Triggers a save + broadcast of the recomputed report.
   */
  record(agentId: string, provider: AgentProvider, deltas: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    turns?: number;
  }): void {
    const usage = agentService.getTokenUsage(agentId);
    const saneDeltaCeiling = Math.max(usage?.contextLimit || 200000, 200000) * 2;
    const inputTokens = Math.min(Math.max(0, deltas.inputTokens ?? 0), saneDeltaCeiling);
    const outputTokens = Math.min(Math.max(0, deltas.outputTokens ?? 0), saneDeltaCeiling);
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
    broadcastReport();
  },

  /** Snapshot the current log for persistence. */
  getEvents(): UsageEvent[] {
    return events;
  },

  /** Build the full report — used by ws.ts on each WS connect. */
  getReportForConnect(): UsageReport {
    return computeReport();
  },
};
