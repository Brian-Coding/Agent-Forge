import type {
  AgentProvider,
  ProviderTokenBucket,
  UsageBreakdownRow,
  UsageDailyRow,
  UsageEvent,
  UsageReport,
  UsageWindowReport,
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

function startOfMonthMs(): number {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local YYYY-MM-DD for a timestamp. */
function localDateKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// Report compute
// ---------------------------------------------------------------------------

const WINDOW_KEYS = ['today', 'days7', 'days30', 'month', 'allTime'] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];

const UNRECORDED_MODEL = '(unrecorded)';
const RECENT_TURNS_CAP = 12;

interface WindowAccumulator {
  summary: WindowTokenSummary;
  byAgent: Map<string, UsageBreakdownRow>;
  byModel: Map<string, UsageBreakdownRow>;
  biggestTurn: UsageWindowReport['stats']['biggestTurn'];
}

function newAccumulator(): WindowAccumulator {
  return { summary: emptyWindow(), byAgent: new Map(), byModel: new Map(), biggestTurn: null };
}

function addToBreakdown(map: Map<string, UsageBreakdownRow>, key: string, label: string, ev: UsageEvent): void {
  let row = map.get(key);
  if (!row) {
    row = { key, label, claude: emptyBucket(), codex: emptyBucket(), total: emptyBucket(), lastTimestamp: 0 };
    map.set(key, row);
  }
  if (ev.provider === 'claude') addInto(row.claude, ev);
  else if (ev.provider === 'codex') addInto(row.codex, ev);
  addInto(row.total, ev);
  if (ev.timestamp > row.lastTimestamp) row.lastTimestamp = ev.timestamp;
  // Prefer the freshest known label (agents get renamed; old events may carry stale names).
  if (label && label !== row.label && ev.timestamp >= row.lastTimestamp) row.label = label;
}

function finalizeWindow(acc: WindowAccumulator): UsageWindowReport {
  const sortRows = (rows: UsageBreakdownRow[]) =>
    rows.sort((a, b) => (b.total.inputTokens + b.total.outputTokens) - (a.total.inputTokens + a.total.outputTokens));
  const t = acc.summary.total;
  return {
    summary: acc.summary,
    byAgent: sortRows(Array.from(acc.byAgent.values())),
    byModel: sortRows(Array.from(acc.byModel.values())),
    stats: {
      totalTokens: t.inputTokens + t.outputTokens,
      turns: t.turns,
      avgInputPerTurn: t.turns > 0 ? Math.round(t.inputTokens / t.turns) : 0,
      avgOutputPerTurn: t.turns > 0 ? Math.round(t.outputTokens / t.turns) : 0,
      outputInputRatio: t.inputTokens > 0 ? Math.round((t.outputTokens / t.inputTokens) * 1000) / 1000 : null,
      biggestTurn: acc.biggestTurn,
    },
  };
}

function agentLabelFor(ev: UsageEvent): string {
  // Live registry name wins (handles renames); stamped name covers deleted agents.
  const live = agentService.getAgent(ev.agentId)?.name;
  return live || ev.agentName || ev.agentId;
}

function computeReport(): UsageReport {
  const now = Date.now();
  const boundaries: Record<WindowKey, number> = {
    today: startOfTodayMs(),
    days7: now - 7 * 24 * 60 * 60 * 1000,
    days30: now - 30 * 24 * 60 * 60 * 1000,
    month: startOfMonthMs(),
    allTime: -Infinity,
  };
  const accs: Record<WindowKey, WindowAccumulator> = {
    today: newAccumulator(),
    days7: newAccumulator(),
    days30: newAccumulator(),
    month: newAccumulator(),
    allTime: newAccumulator(),
  };

  // Zero-filled last 30 calendar days, oldest first.
  const dailyMap = new Map<string, UsageDailyRow>();
  for (let i = 29; i >= 0; i--) {
    const key = localDateKey(now - i * 24 * 60 * 60 * 1000);
    dailyMap.set(key, { date: key, claude: emptyBucket(), codex: emptyBucket(), total: emptyBucket() });
  }

  for (const ev of events) {
    const agentLabel = agentLabelFor(ev);
    const modelKey = ev.model || UNRECORDED_MODEL;
    const turnTokens = ev.inputTokens + ev.outputTokens;

    for (const key of WINDOW_KEYS) {
      if (ev.timestamp < boundaries[key]) continue;
      const acc = accs[key];
      addEventToWindow(acc.summary, ev);
      addToBreakdown(acc.byAgent, ev.agentId, agentLabel, ev);
      addToBreakdown(acc.byModel, modelKey, modelKey, ev);
      if (turnTokens > 0 && (!acc.biggestTurn || turnTokens > acc.biggestTurn.tokens)) {
        acc.biggestTurn = {
          tokens: turnTokens,
          agentName: agentLabel,
          provider: ev.provider,
          model: ev.model,
          timestamp: ev.timestamp,
        };
      }
    }

    const dayRow = dailyMap.get(localDateKey(ev.timestamp));
    if (dayRow) {
      if (ev.provider === 'claude') addInto(dayRow.claude, ev);
      else if (ev.provider === 'codex') addInto(dayRow.codex, ev);
      addInto(dayRow.total, ev);
    }
  }

  // The log is append-only (chronological) in normal operation, but sort
  // defensively — a hand-edited or merged data.json must not scramble this.
  const recentTurns = events
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, RECENT_TURNS_CAP)
    .map(ev => ({
      timestamp: ev.timestamp,
      agentName: agentLabelFor(ev),
      provider: ev.provider,
      model: ev.model,
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
    }));

  return {
    windows: {
      today: finalizeWindow(accs.today),
      days7: finalizeWindow(accs.days7),
      days30: finalizeWindow(accs.days30),
      month: finalizeWindow(accs.month),
      allTime: finalizeWindow(accs.allTime),
    },
    daily: Array.from(dailyMap.values()),
    recentTurns,
    generatedAt: now,
  };
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
            model: typeof ev.model === 'string' && ev.model ? ev.model : undefined,
            agentName: typeof ev.agentName === 'string' && ev.agentName ? ev.agentName : undefined,
            workspaceId: typeof ev.workspaceId === 'string' && ev.workspaceId ? ev.workspaceId : undefined,
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
  }, meta?: { model?: string }): void {
    // Guard against a single corrupt/absurd delta blowing up the totals, but
    // do NOT scale the ceiling to the context window: Codex's
    // turn.completed.usage.input_tokens is a per-turn AGGREGATE across every
    // model call in the turn, which on long agentic turns legitimately reaches
    // millions (each tool round re-sends the context). The old
    // max(contextLimit,200k)*2 ceiling (~516k) silently clipped those, under-
    // reporting Codex spend in the Tokens tab. A flat, generous ceiling catches
    // garbage without truncating real turns.
    const saneDeltaCeiling = 100_000_000;
    const inputTokens = Math.min(Math.max(0, deltas.inputTokens ?? 0), saneDeltaCeiling);
    const outputTokens = Math.min(Math.max(0, deltas.outputTokens ?? 0), saneDeltaCeiling);
    const costUsd = Math.max(0, deltas.costUsd ?? 0);
    const turns = Math.max(0, deltas.turns ?? 0);
    if (inputTokens === 0 && outputTokens === 0 && costUsd === 0 && turns === 0) return;
    const agent = agentService.getAgent(agentId);
    events.push({
      timestamp: Date.now(),
      agentId,
      provider,
      inputTokens,
      outputTokens,
      costUsd,
      turns,
      model: meta?.model || undefined,
      agentName: agent?.name || undefined,
      workspaceId: agent?.workspaceId || undefined,
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

  /**
   * Raw event export for the Tokens tab's CSV/JSON buttons. Rows are
   * label-enriched so the export is useful outside the app.
   */
  buildExportRows(): Array<{
    timestamp: number;
    iso: string;
    agentId: string;
    agentName: string;
    provider: AgentProvider;
    model: string;
    workspaceId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    turns: number;
    costUsd: number;
  }> {
    return events.map(ev => ({
      timestamp: ev.timestamp,
      iso: new Date(ev.timestamp).toISOString(),
      agentId: ev.agentId,
      agentName: agentLabelFor(ev),
      provider: ev.provider,
      model: ev.model || '',
      workspaceId: ev.workspaceId || '',
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      totalTokens: ev.inputTokens + ev.outputTokens,
      turns: ev.turns,
      costUsd: ev.costUsd,
    }));
  },
};
