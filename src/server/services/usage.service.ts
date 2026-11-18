import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type {
  AgentProvider,
  ProviderTokenBucket,
  UsageBreakdownRow,
  UsageDailyRow,
  UsageEvent,
  UsageReport,
  UsageProjectGroup,
  UsageWindowReport,
  WindowTokenSummary,
} from '../../shared/protocol';
import { broadcast } from '../broadcast';
import { agentService } from './agent.service';
import { persistenceService } from './persistence.service';
import { workspaceService } from './workspace.service';

// HMR-safe append-only log. One row per finalized turn (~150 bytes); for a heavy
// user that's still under ~10MB after years of use, comfortably small for data.json.
const events: UsageEvent[] = (globalThis as any).__usageEvents ??= [];

const SYNC_REFRESH_INTERVAL_MS = 60_000;
const PROJECT_TURNS_CAP = 100;
const machineId = sanitizeMachineId(process.env.AGENT_FORGE_MACHINE_ID || hostname() || 'local');
// Live usage is runtime state kept outside the source tree. Each machine writes
// only its own shard; point AGENT_FORGE_USAGE_SYNC_DIR at a folder you already
// sync between machines (Syncthing, a cloud drive, ...) to merge usage reports.
const runtimeSyncDirectory = process.env.AGENT_FORGE_USAGE_SYNC_DIR
  || join(homedir(), '.agent-forge', 'usage-sync', 'usage');
const shardPath = join(runtimeSyncDirectory, `${machineId}.json`);
let localShardEvents: UsageEvent[] = [];
let syncEnabled = false;
let machineCount = 1;
let knownMachineIds = new Set<string>([machineId]);

function sanitizeMachineId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
}

function legacyEventId(ev: Pick<UsageEvent, 'timestamp' | 'agentId' | 'provider' | 'inputTokens' | 'outputTokens' | 'turns' | 'model'>): string {
  const identity = [ev.timestamp, ev.agentId, ev.provider, ev.inputTokens, ev.outputTokens, ev.turns, ev.model || ''].join('|');
  return `legacy-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function normalizeEvent(ev: UsageEvent): UsageEvent | null {
  if (!ev || typeof ev !== 'object'
    || typeof ev.timestamp !== 'number' || !Number.isFinite(ev.timestamp)
    || typeof ev.agentId !== 'string' || !ev.agentId
    || (ev.provider !== 'claude' && ev.provider !== 'codex')) return null;
  const finiteNonNegative = (value: unknown, ceiling = Number.MAX_SAFE_INTEGER): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? Math.min(value, ceiling)
      : 0;
  const inputTokens = finiteNonNegative(ev.inputTokens, 100_000_000);
  const outputTokens = finiteNonNegative(ev.outputTokens, 100_000_000);
  const turns = finiteNonNegative(ev.turns, 1_000_000);
  const normalized: UsageEvent = {
    id: typeof ev.id === 'string' && ev.id ? ev.id : legacyEventId({
      timestamp: ev.timestamp,
      agentId: ev.agentId,
      provider: ev.provider,
      inputTokens,
      outputTokens,
      turns,
      model: typeof ev.model === 'string' ? ev.model : undefined,
    }),
    machineId: typeof ev.machineId === 'string' && ev.machineId ? ev.machineId : 'legacy',
    timestamp: ev.timestamp,
    agentId: ev.agentId,
    provider: ev.provider,
    inputTokens,
    outputTokens,
    costUsd: finiteNonNegative(ev.costUsd, 1_000_000),
    turns,
    model: typeof ev.model === 'string' && ev.model ? ev.model : undefined,
    agentName: typeof ev.agentName === 'string' && ev.agentName ? ev.agentName : undefined,
    workspaceId: typeof ev.workspaceId === 'string' && ev.workspaceId ? ev.workspaceId : undefined,
    workspaceName: typeof ev.workspaceName === 'string' && ev.workspaceName ? ev.workspaceName : undefined,
  };
  return normalized;
}

function mergeEvents(incoming: readonly UsageEvent[]): boolean {
  const byId = new Map(events.map(ev => [ev.id || legacyEventId(ev), ev]));
  let changed = false;
  for (const raw of incoming) {
    const ev = normalizeEvent(raw);
    if (!ev || byId.has(ev.id!)) continue;
    byId.set(ev.id!, ev);
    changed = true;
  }
  if (changed) {
    events.length = 0;
    events.push(...Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp));
  }
  return changed;
}

export function selectEventsForMachineShard(incoming: readonly UsageEvent[], currentMachineId: string): UsageEvent[] {
  const normalizedMachineId = sanitizeMachineId(currentMachineId);
  const byId = new Map<string, UsageEvent>();
  for (const raw of incoming) {
    const event = normalizeEvent(raw);
    if (!event) continue;
    const eventMachineId = !event.machineId || event.machineId === 'legacy'
      ? normalizedMachineId
      : sanitizeMachineId(event.machineId);
    if (eventMachineId === normalizedMachineId && !byId.has(event.id!)) {
      byId.set(event.id!, event);
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function readShard(path: string): UsageEvent[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeEvent).filter((ev): ev is UsageEvent => ev !== null);
  } catch (error) {
    console.warn(`[usage] could not read sync shard ${path}:`, error);
    return [];
  }
}

function writeLocalShard(): void {
  if (!syncEnabled) return;
  try {
    mkdirSync(runtimeSyncDirectory, { recursive: true });
    const tempPath = `${shardPath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(localShardEvents, null, 2), 'utf8');
    renameSync(tempPath, shardPath);
  } catch (error) {
    console.warn('[usage] could not write cross-machine usage shard:', error);
  }
}

function refreshFromShards(): void {
  if (!syncEnabled) return;
  try {
    const directory = runtimeSyncDirectory;
    const shardFiles = existsSync(directory)
      ? readdirSync(directory).filter(name => name.endsWith('.json')).map(name => ({ directory, name }))
      : [];
    knownMachineIds = new Set([machineId, ...shardFiles.map(({ name }) => sanitizeMachineId(name.slice(0, -'.json'.length)))]);
    const machineCountChanged = machineCount !== knownMachineIds.size;
    machineCount = knownMachineIds.size;
    const changed = shardFiles.reduce((didChange, { directory, name }) => mergeEvents(readShard(join(directory, name))) || didChange, false);
    if (changed) persistenceService.save();
    if (changed || machineCountChanged) broadcastReport();
  } catch (error) {
    console.warn('[usage] could not refresh cross-machine usage:', error);
  }
}

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
interface WindowAccumulator {
  summary: WindowTokenSummary;
  byAgent: Map<string, UsageBreakdownRow>;
  byModel: Map<string, UsageBreakdownRow>;
  projects: Map<string, UsageProjectGroup>;
  biggestTurn: UsageWindowReport['stats']['biggestTurn'];
}

function newAccumulator(): WindowAccumulator {
  return { summary: emptyWindow(), byAgent: new Map(), byModel: new Map(), projects: new Map(), biggestTurn: null };
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
    projects: Array.from(acc.projects.values())
      .map(project => ({
        ...project,
        turns: project.turns.sort((a, b) => b.timestamp - a.timestamp).slice(0, PROJECT_TURNS_CAP),
      }))
      .sort((a, b) => {
        const tokenDelta = (b.total.inputTokens + b.total.outputTokens) - (a.total.inputTokens + a.total.outputTokens);
        return tokenDelta || b.lastTimestamp - a.lastTimestamp;
      }),
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

function addToProject(acc: WindowAccumulator, ev: UsageEvent, agentName: string): void {
  const workspaceId = ev.workspaceId || 'unassigned';
  const liveName = ev.workspaceId ? workspaceService.get(ev.workspaceId)?.name : undefined;
  const workspaceName = liveName || ev.workspaceName || (ev.workspaceId ? ev.workspaceId : 'Unassigned');
  let project = acc.projects.get(workspaceId);
  if (!project) {
    project = {
      workspaceId,
      workspaceName,
      total: emptyBucket(),
      lastTimestamp: 0,
      eventCount: 0,
      turns: [],
    };
    acc.projects.set(workspaceId, project);
  }
  project.workspaceName = workspaceName;
  addInto(project.total, ev);
  project.eventCount++;
  project.lastTimestamp = Math.max(project.lastTimestamp, ev.timestamp);
  project.turns.push({
    id: ev.id || legacyEventId(ev),
    timestamp: ev.timestamp,
    agentId: ev.agentId,
    agentName,
    provider: ev.provider,
    model: ev.model,
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    turns: ev.turns,
  });
}

function agentLabelFor(ev: UsageEvent): string {
  // Live registry name wins (handles renames); stamped name covers deleted agents.
  const live = agentService.getAgent(ev.agentId)?.name;
  return live || ev.agentName || ev.agentId;
}

function computeScopedReport(scopedEvents: readonly UsageEvent[], now: number): Pick<UsageReport, 'windows' | 'daily' | 'trackingStartedAt'> {
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

  for (const ev of scopedEvents) {
    const agentLabel = agentLabelFor(ev);
    const modelKey = ev.model || UNRECORDED_MODEL;
    const turnTokens = ev.inputTokens + ev.outputTokens;

    for (const key of WINDOW_KEYS) {
      if (ev.timestamp < boundaries[key]) continue;
      const acc = accs[key];
      addEventToWindow(acc.summary, ev);
      addToBreakdown(acc.byAgent, ev.agentId, agentLabel, ev);
      addToBreakdown(acc.byModel, modelKey, modelKey, ev);
      addToProject(acc, ev, agentLabel);
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
  return {
    windows: {
      today: finalizeWindow(accs.today),
      days7: finalizeWindow(accs.days7),
      days30: finalizeWindow(accs.days30),
      month: finalizeWindow(accs.month),
      allTime: finalizeWindow(accs.allTime),
    },
    daily: Array.from(dailyMap.values()),
    trackingStartedAt: scopedEvents.reduce<number | null>((earliest, ev) => earliest === null ? ev.timestamp : Math.min(earliest, ev.timestamp), null),
  };
}

function effectiveMachineId(ev: UsageEvent): string {
  // Events recorded before machine shards existed are local legacy history.
  return !ev.machineId || ev.machineId === 'legacy' ? machineId : sanitizeMachineId(ev.machineId);
}

function computeReport(): UsageReport {
  const now = Date.now();
  const combined = computeScopedReport(events, now);
  const currentEvents = events.filter(ev => effectiveMachineId(ev) === machineId);
  const currentMachine = computeScopedReport(currentEvents, now);
  const representedMachineIds = new Set([...knownMachineIds, ...events.map(effectiveMachineId)]);
  const machines = Array.from(representedMachineIds).map(id => {
    const machineEvents = events.filter(ev => effectiveMachineId(ev) === id);
    const scoped = computeScopedReport(machineEvents, now);
    return {
      machineId: id,
      isCurrent: id === machineId,
      eventCount: machineEvents.length,
      trackingStartedAt: scoped.trackingStartedAt,
      lastTimestamp: machineEvents.reduce<number | null>((latest, ev) => latest === null ? ev.timestamp : Math.max(latest, ev.timestamp), null),
      windows: {
        today: scoped.windows.today.summary,
        days7: scoped.windows.days7.summary,
        days30: scoped.windows.days30.summary,
        month: scoped.windows.month.summary,
        allTime: scoped.windows.allTime.summary,
      },
    };
  }).sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const aTokens = a.windows.allTime.total.inputTokens + a.windows.allTime.total.outputTokens;
    const bTokens = b.windows.allTime.total.inputTokens + b.windows.allTime.total.outputTokens;
    return bTokens - aTokens || a.machineId.localeCompare(b.machineId);
  });

  return {
    ...combined,
    currentMachine,
    machines,
    sync: {
      enabled: syncEnabled,
      machineId,
      machineCount,
      directory: syncEnabled ? runtimeSyncDirectory : null,
    },
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
    localShardEvents = [];
    syncEnabled = false;
    machineCount = 1;
    knownMachineIds = new Set([machineId]);
    if (Array.isArray(persisted)) {
      const seen = new Set<string>();
      for (const ev of persisted) {
        const normalized = normalizeEvent(ev);
        if (normalized && !seen.has(normalized.id!)) {
          seen.add(normalized.id!);
          events.push(normalized);
        }
      }
    }
  },

  /**
   * Merge one append-only runtime shard per machine plus Git-backed snapshots.
   * The live shard defaults to the user's .agent-forge directory so ordinary
   * turns never modify the source repository. AGENT_FORGE_USAGE_SYNC_DIR can
   * point at another runtime/shared directory when explicitly desired.
   */
  startSync(): void {
    const globals = globalThis as any;
    if (globals.__usageSyncTimer) clearInterval(globals.__usageSyncTimer);
    syncEnabled = true;
    try {
      mkdirSync(runtimeSyncDirectory, { recursive: true });
      localShardEvents = existsSync(shardPath)
        ? readShard(shardPath)
        : [];
      refreshFromShards();
      // The runtime file may be new while persistence or the repository still
      // contains older local history. Absorb and deduplicate that history before
      // writing so a later Git snapshot never truncates the machine's timeline.
      localShardEvents = selectEventsForMachineShard([...localShardEvents, ...events], machineId);
      writeLocalShard();
      globals.__usageSyncTimer = setInterval(refreshFromShards, SYNC_REFRESH_INTERVAL_MS);
      globals.__usageSyncTimer.unref?.();
    } catch (error) {
      syncEnabled = false;
      console.warn('[usage] cross-machine sync disabled:', error);
    }
  },

  stopSync(): void {
    const globals = globalThis as any;
    if (globals.__usageSyncTimer) clearInterval(globals.__usageSyncTimer);
    globals.__usageSyncTimer = null;
    syncEnabled = false;
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
    const finiteNonNegative = (value: unknown, ceiling: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.min(value, ceiling)
        : 0;
    const inputTokens = finiteNonNegative(deltas.inputTokens, saneDeltaCeiling);
    const outputTokens = finiteNonNegative(deltas.outputTokens, saneDeltaCeiling);
    const costUsd = finiteNonNegative(deltas.costUsd, 1_000_000);
    const turns = finiteNonNegative(deltas.turns, 1_000_000);
    if (inputTokens === 0 && outputTokens === 0 && costUsd === 0 && turns === 0) return;
    const agent = agentService.getAgent(agentId);
    const workspace = agent?.workspaceId ? workspaceService.get(agent.workspaceId) : undefined;
    const event: UsageEvent = {
      id: `${machineId}-${Date.now()}-${randomUUID()}`,
      machineId,
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
      workspaceName: workspace?.name || undefined,
    };
    events.push(event);
    if (syncEnabled) {
      localShardEvents.push(event);
      writeLocalShard();
    }
    persistenceService.save();
    broadcastReport();
  },

  /** Snapshot the current log for persistence. */
  getEvents(): UsageEvent[] {
    return events.map(event => ({ ...event }));
  },

  /** Build the full report — used by ws.ts on each WS connect. */
  getReportForConnect(): UsageReport {
    return computeReport();
  },

  /**
   * Raw event export for the Tokens tab's CSV/JSON buttons. Rows are
   * label-enriched so the export is useful outside the app.
   */
  buildExportRows(scope: 'current' | 'all' = 'all'): Array<{
    id: string;
    machineId: string;
    timestamp: number;
    iso: string;
    agentId: string;
    agentName: string;
    provider: AgentProvider;
    model: string;
    workspaceId: string;
    workspaceName: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    turns: number;
    costUsd: number;
  }> {
    const exportEvents = scope === 'current'
      ? events.filter(ev => effectiveMachineId(ev) === machineId)
      : events;
    return exportEvents.map(ev => ({
      id: ev.id || legacyEventId(ev),
      machineId: effectiveMachineId(ev),
      timestamp: ev.timestamp,
      iso: new Date(ev.timestamp).toISOString(),
      agentId: ev.agentId,
      agentName: agentLabelFor(ev),
      provider: ev.provider,
      model: ev.model || '',
      workspaceId: ev.workspaceId || '',
      workspaceName: ev.workspaceId
        ? (workspaceService.get(ev.workspaceId)?.name || ev.workspaceName || ev.workspaceId)
        : (ev.workspaceName || 'Unassigned'),
      inputTokens: ev.inputTokens,
      outputTokens: ev.outputTokens,
      totalTokens: ev.inputTokens + ev.outputTokens,
      turns: ev.turns,
      costUsd: ev.costUsd,
    }));
  },
};
