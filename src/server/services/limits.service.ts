/**
 * Provider rate-limit tracking for the Limits sidebar tab.
 *
 * Claude: we read the same OAuth usage endpoint the `/status` command uses —
 * `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the
 * access token Claude Code already stores in `~/.claude/.credentials.json`
 * (kept fresh by every Claude turn the app runs). It's a free GET (no
 * inference cost) and returns five_hour / seven_day utilization + reset times.
 * This works fully headlessly — no interactive statusLine session required.
 * The old statusLine JSON bridge (scripts/claude-limits-statusline.ts →
 * `~/.claude/claude-code-limits.json`) remains as a fallback for when the
 * credentials file is absent or the token is expired.
 *
 * Codex: the Codex CLI (0.125+) records a `token_count` event carrying a full
 * `rate_limits` payload (primary = 5h window, secondary = weekly) in its
 * rollout files under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. We scan
 * the newest rollout files for the last such event. This is strictly better
 * than the /status TUI-capture fallback that was originally planned — fully
 * passive, machine-readable, and it also yields context-window usage.
 *
 * Both providers refresh every 30 minutes plus on demand (refresh_limits).
 * Results are cached per provider so one broken source never blanks the tab.
 */
import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { LimitsSnapshot, LimitsWindow, ProviderLimitsSnapshot } from '../../shared/protocol';
import { broadcast } from '../broadcast';

export const LIMITS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
/** Data older than this renders as 'stale' — usage percentages decay, so old reads mislead. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** How many recent rollout files to scan before giving up (fresh sessions may lack the event). */
const CODEX_FILE_SCAN_CAP = 6;
/** Read only the tail of large rollout files — the last rate_limits event is what matters. */
const CODEX_TAIL_BYTES = 512 * 1024;

// HMR-safe cached snapshot + timer.
const state: {
  snapshot: LimitsSnapshot | null;
  timer: ReturnType<typeof setInterval> | null;
  nextRefreshAt: number;
} = (globalThis as any).__limitsState ??= { snapshot: null, timer: null, nextRefreshAt: 0 };

function emptyWindow(): LimitsWindow {
  return { usedPercent: null, resetsAt: null, windowMinutes: null };
}

function baseSnapshot(provider: 'claude' | 'codex', source: string): ProviderLimitsSnapshot {
  return {
    provider,
    status: 'unavailable',
    updatedAt: null,
    checkedAt: Date.now(),
    model: null,
    planType: null,
    contextUsedPercent: null,
    fiveHour: emptyWindow(),
    weekly: emptyWindow(),
    source,
    detail: null,
  };
}

/** Accept epoch seconds, epoch ms, or an ISO string; return epoch ms or null. */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 10_000_000_000 ? v : v * 1000; // heuristic: values < 1e10 are seconds
  }
  if (typeof v === 'string' && v) {
    const parsed = Date.parse(v);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function toPercent(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(100, v));
  return null;
}

function applyFreshness(snap: ProviderLimitsSnapshot): void {
  if (snap.status !== 'available') return;
  if (snap.updatedAt !== null && Date.now() - snap.updatedAt > STALE_AFTER_MS) {
    snap.status = 'stale';
    snap.detail = 'Data is over 6h old — send a turn with this provider to refresh it.';
  }
}

// ---------------------------------------------------------------------------
// Claude — OAuth usage endpoint (primary) + statusline bridge (fallback)
// ---------------------------------------------------------------------------

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export function claudeCredentialsPath(): string {
  return process.env.AI_HARNESS_CLAUDE_CREDENTIALS_JSON || join(homedir(), '.claude', '.credentials.json');
}

export function claudeLimitsFilePath(): string {
  return process.env.AI_HARNESS_CLAUDE_LIMITS_JSON || join(homedir(), '.claude', 'claude-code-limits.json');
}

async function readClaudeOAuth(): Promise<{ token: string; subscriptionType: string | null } | null> {
  try {
    const file = Bun.file(claudeCredentialsPath());
    if (!(await file.exists())) return null;
    const data = JSON.parse(await file.text());
    const oa = data?.claudeAiOauth ?? data?.oauth ?? {};
    const token = oa.accessToken ?? oa.access_token;
    if (typeof token !== 'string' || !token) return null;
    return { token, subscriptionType: typeof oa.subscriptionType === 'string' ? oa.subscriptionType : null };
  } catch {
    return null;
  }
}

/**
 * Pure mapping from the /api/oauth/usage JSON to a provider snapshot. Split
 * out so it can be unit-tested without a live network call.
 */
export function mapClaudeUsageResponse(data: any, subscriptionType: string | null): ProviderLimitsSnapshot {
  const snap = baseSnapshot('claude', `oauth usage → ${CLAUDE_USAGE_URL}`);
  snap.updatedAt = Date.now();
  snap.planType = subscriptionType;
  snap.fiveHour = {
    usedPercent: toPercent(data?.five_hour?.utilization),
    resetsAt: toEpochMs(data?.five_hour?.resets_at),
    windowMinutes: 300,
  };
  snap.weekly = {
    usedPercent: toPercent(data?.seven_day?.utilization),
    resetsAt: toEpochMs(data?.seven_day?.resets_at),
    windowMinutes: 10080,
  };
  snap.status = 'available';
  applyFreshness(snap);
  return snap;
}

async function readClaudeLimitsFromOAuth(): Promise<ProviderLimitsSnapshot | null> {
  const creds = await readClaudeOAuth();
  if (!creds) return null;
  const snap = baseSnapshot('claude', `oauth usage → ${CLAUDE_USAGE_URL}`);
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${creds.token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      // Token expired/invalid — Claude Code refreshes it on its next run.
      snap.status = 'unavailable';
      snap.detail = 'Claude OAuth token expired — run any Claude turn to refresh it.';
      return snap;
    }
    if (!res.ok) {
      snap.status = 'error';
      snap.detail = `Usage endpoint returned HTTP ${res.status}.`;
      return snap;
    }
    return mapClaudeUsageResponse(await res.json(), creds.subscriptionType);
  } catch (e: any) {
    snap.status = 'error';
    snap.detail = `Failed to reach usage endpoint: ${e?.message || String(e)}`;
    return snap;
  }
}

async function readClaudeLimitsFromBridge(): Promise<ProviderLimitsSnapshot> {
  const path = claudeLimitsFilePath();
  const snap = baseSnapshot('claude', `statusline bridge → ${path}`);
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      snap.status = 'unavailable';
      snap.detail = 'No Claude credentials or statusLine bridge file found.';
      return snap;
    }
    const data = JSON.parse(await file.text());
    snap.updatedAt = toEpochMs(data.updated_at);
    snap.model = typeof data.model === 'string' && data.model ? data.model : null;
    snap.contextUsedPercent = toPercent(data.context_used_percentage);
    snap.fiveHour = {
      usedPercent: toPercent(data.five_hour_used_percentage),
      resetsAt: toEpochMs(data.five_hour_resets_at),
      windowMinutes: 300,
    };
    snap.weekly = {
      usedPercent: toPercent(data.seven_day_used_percentage),
      resetsAt: toEpochMs(data.seven_day_resets_at),
      windowMinutes: 10080,
    };
    snap.status = 'available';
    applyFreshness(snap);
  } catch (e: any) {
    snap.status = 'error';
    snap.detail = `Failed to read bridge file: ${e?.message || String(e)}`;
  }
  return snap;
}

async function readClaudeLimits(): Promise<ProviderLimitsSnapshot> {
  // Primary: the OAuth usage endpoint /status uses — passive, zero inference
  // cost, works headlessly. Fall back to the statusline bridge only if the
  // credentials are missing or the token is expired.
  const oauth = await readClaudeLimitsFromOAuth();
  if (oauth && oauth.status === 'available') return oauth;
  const bridge = await readClaudeLimitsFromBridge();
  if (bridge.status === 'available') return bridge;
  // Neither produced usable data — surface the OAuth detail when we have one
  // (it's the more actionable message), otherwise the bridge's.
  return oauth ?? bridge;
}

// ---------------------------------------------------------------------------
// Codex — rollout-file rate_limits events
// ---------------------------------------------------------------------------

function codexSessionsRoot(): string {
  return process.env.AI_HARNESS_CODEX_SESSIONS_DIR || join(homedir(), '.codex', 'sessions');
}

/** Directory names sorted numerically descending (years, months, days). */
function numericDirsDesc(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
      .map(d => d.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return [];
  }
}

/** Newest rollout files across the most recent day-directories, newest first. */
function newestRolloutFiles(cap: number): string[] {
  const root = codexSessionsRoot();
  if (!existsSync(root)) return [];
  const files: Array<{ path: string; mtime: number }> = [];
  outer:
  for (const year of numericDirsDesc(root)) {
    for (const month of numericDirsDesc(join(root, year))) {
      for (const day of numericDirsDesc(join(root, year, month))) {
        const dayDir = join(root, year, month, day);
        try {
          for (const f of readdirSync(dayDir)) {
            if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
            const p = join(dayDir, f);
            files.push({ path: p, mtime: statSync(p).mtimeMs });
          }
        } catch {}
        if (files.length >= cap) break outer;
      }
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, cap).map(f => f.path);
}

/** Last `rate_limits`-bearing event in one rollout file's tail, or null. */
async function lastRateLimitEvent(path: string): Promise<any | null> {
  const file = Bun.file(path);
  const size = file.size;
  const slice = size > CODEX_TAIL_BYTES ? file.slice(size - CODEX_TAIL_BYTES, size) : file;
  const text = await slice.text();
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.payload?.rate_limits) return parsed;
    } catch {
      // Truncated first line of a tail slice — keep walking up.
    }
  }
  return null;
}

async function readCodexLimits(): Promise<ProviderLimitsSnapshot> {
  const snap = baseSnapshot('codex', `rollout files → ${codexSessionsRoot()}`);
  try {
    const files = newestRolloutFiles(CODEX_FILE_SCAN_CAP);
    if (files.length === 0) {
      snap.status = 'unavailable';
      snap.detail = 'No Codex rollout files found. They appear after the first Codex CLI session.';
      return snap;
    }
    for (const path of files) {
      const event = await lastRateLimitEvent(path);
      if (!event) continue;
      const payload = event.payload;
      const rl = payload.rate_limits;
      snap.updatedAt = toEpochMs(event.timestamp);
      snap.planType = typeof rl.plan_type === 'string' ? rl.plan_type : null;
      snap.fiveHour = {
        usedPercent: toPercent(rl.primary?.used_percent),
        resetsAt: toEpochMs(rl.primary?.resets_at),
        windowMinutes: typeof rl.primary?.window_minutes === 'number' ? rl.primary.window_minutes : 300,
      };
      snap.weekly = {
        usedPercent: toPercent(rl.secondary?.used_percent),
        resetsAt: toEpochMs(rl.secondary?.resets_at),
        windowMinutes: typeof rl.secondary?.window_minutes === 'number' ? rl.secondary.window_minutes : 10080,
      };
      const info = payload.info;
      if (info?.last_token_usage?.total_tokens && info?.model_context_window) {
        snap.contextUsedPercent = toPercent((info.last_token_usage.total_tokens / info.model_context_window) * 100);
      }
      snap.status = 'available';
      applyFreshness(snap);
      return snap;
    }
    snap.status = 'unavailable';
    snap.detail = `No rate_limits events in the ${files.length} newest rollout file(s) — send a Codex turn and refresh.`;
  } catch (e: any) {
    snap.status = 'error';
    snap.detail = `Failed to read rollout files: ${e?.message || String(e)}`;
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const limitsService = {
  async refresh(broadcastIt = true): Promise<LimitsSnapshot> {
    // Providers are independent — one failing source must not blank the other.
    const [claude, codex] = await Promise.all([readClaudeLimits(), readCodexLimits()]);
    const snapshot: LimitsSnapshot = {
      providers: { claude, codex },
      refreshIntervalMs: LIMITS_REFRESH_INTERVAL_MS,
      nextRefreshAt: state.nextRefreshAt || Date.now() + LIMITS_REFRESH_INTERVAL_MS,
    };
    state.snapshot = snapshot;
    if (broadcastIt) broadcast({ type: 'limits_snapshot', snapshot });
    return snapshot;
  },

  /** Cached snapshot for WS connect; kicks off a first read if none exists yet. */
  getSnapshot(): LimitsSnapshot | null {
    return state.snapshot;
  },

  /** Start the 30-minute refresh loop. Idempotent (HMR-safe). */
  start(): void {
    if (state.timer) clearInterval(state.timer);
    state.nextRefreshAt = Date.now() + LIMITS_REFRESH_INTERVAL_MS;
    state.timer = setInterval(() => {
      state.nextRefreshAt = Date.now() + LIMITS_REFRESH_INTERVAL_MS;
      limitsService.refresh().catch(e => console.error('[limits] scheduled refresh failed:', e));
    }, LIMITS_REFRESH_INTERVAL_MS);
    limitsService.refresh().catch(e => console.error('[limits] initial refresh failed:', e));
  },
};
