/**
 * Provider rate-limit tracking for the Limits sidebar tab.
 *
 * Claude: we read the same OAuth usage endpoint the `/status` command uses —
 * `GET https://api.anthropic.com/api/oauth/usage`, authenticated with the
 * access token Claude Code already stores in `~/.claude/.credentials.json`
 * (kept fresh by every Claude turn the app runs). It's a free GET (no
 * inference cost) and returns five_hour / seven_day utilization + reset times,
 * plus Claude's model-specific weekly window (`seven_day_sonnet`, currently
 * presented as Fable in Claude's usage UI).
 * This works fully headlessly — no interactive statusLine session required.
 * The old statusLine JSON bridge (scripts/claude-limits-statusline.ts →
 * `~/.claude/claude-code-limits.json`) remains as a fallback for when the
 * credentials file is absent or the token is expired.
 *
 * Codex: the CLI app-server's `account/rateLimits/read` method is the primary
 * source. It reflects the live account state used by Codex status surfaces,
 * including manual usage resets. Rollout `token_count.rate_limits` events
 * remain a passive fallback and also yield context-window usage when the live
 * interface is unavailable.
 *
 * Both providers refresh every minute plus on demand (refresh_limits).
 * Results are cached per provider so one broken source never blanks the tab.
 */
import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { LimitsSnapshot, LimitsWindow, ProviderLimitsSnapshot } from '../../shared/protocol';
import { broadcast } from '../broadcast';
import { resolveCodexLaunchCommand } from '../agents/adapters/codex';
import { drainStreamToString } from '../agents/stream-utils';
import { createCliEnv, killProcessTree, resolveCliBinary, safeSpawn } from '../utils';
import { fetchWithTimeout } from './external-io';

export const LIMITS_REFRESH_INTERVAL_MS = 60 * 1000;
/** Data older than this renders as 'stale' — usage percentages decay, so old reads mislead. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** How many recent rollout files to scan before giving up (fresh sessions may lack the event). */
const CODEX_FILE_SCAN_CAP = 6;
/** Read only the tail of large rollout files — the last rate_limits event is what matters. */
const CODEX_TAIL_BYTES = 512 * 1024;
/** Bound a broken or incompatible app-server instead of blocking refresh forever. */
const CODEX_APP_SERVER_TIMEOUT_MS = 10_000;
const CODEX_APP_SERVER_MAX_RESPONSE_CHARS = 1024 * 1024;
const CODEX_APP_SERVER_STDERR_CHARS = 64 * 1024;
const CLAUDE_USAGE_TIMEOUT_MS = 10_000;
const CLAUDE_BACKOFF_BASE_MS = 60_000;
const CLAUDE_BACKOFF_MAX_MS = 15 * 60_000;

// HMR-safe cached snapshot + timer.
const state: {
  snapshot: LimitsSnapshot | null;
  timer: ReturnType<typeof setInterval> | null;
  nextRefreshAt: number;
  refreshPromise: Promise<LimitsSnapshot> | null;
  claudeBackoffUntil: number;
  claudeFailureCount: number;
} = (globalThis as any).__limitsState ??= {
  snapshot: null,
  timer: null,
  nextRefreshAt: 0,
  refreshPromise: null,
  claudeBackoffUntil: 0,
  claudeFailureCount: 0,
};
// Backfill fields when an older HMR state object is reused.
state.refreshPromise ??= null;
state.claudeBackoffUntil ??= 0;
state.claudeFailureCount ??= 0;

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
    modelWeekly: emptyWindow(),
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

function hasLimitData(snapshot: ProviderLimitsSnapshot): boolean {
  return snapshot.fiveHour.usedPercent !== null
    || snapshot.weekly.usedPercent !== null
    // Optional chaining keeps an older HMR-cached snapshot safe across this
    // protocol addition until the next successful provider refresh.
    || typeof snapshot.modelWeekly?.usedPercent === 'number'
    || snapshot.contextUsedPercent !== null;
}

/** Keep the last successful provider data visible when a refresh source has a
 * transient failure. The failed attempt remains explicit in detail/checkedAt. */
export function mergeProviderLimits(
  previous: ProviderLimitsSnapshot | null | undefined,
  next: ProviderLimitsSnapshot,
): ProviderLimitsSnapshot {
  if (next.status === 'available' || next.status === 'stale') return next;
  if (!previous || !hasLimitData(previous) || !['available', 'stale'].includes(previous.status)) return next;
  return {
    ...previous,
    status: 'stale',
    checkedAt: next.checkedAt,
    detail: `Latest refresh failed (${next.detail || next.status}); showing the last successful data.`,
  };
}

/** Convert Retry-After (seconds or HTTP date) to an absolute epoch-ms value. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(now, date);
}

/**
 * Map Codex's positional limit slots by their declared duration. Codex may
 * promote the weekly limit into `primary` when the 5-hour limit is disabled,
 * so slot position alone is not a reliable label.
 */
export function mapCodexRateLimitWindows(rateLimits: any): Pick<ProviderLimitsSnapshot, 'fiveHour' | 'weekly'> {
  const result = { fiveHour: emptyWindow(), weekly: emptyWindow() };
  const slots = [
    { raw: rateLimits?.primary, legacyTarget: 'fiveHour' as const },
    { raw: rateLimits?.secondary, legacyTarget: 'weekly' as const },
  ];
  const populatedSlots = slots.filter(slot => slot.raw && typeof slot.raw === 'object');

  for (const slot of populatedSlots) {
    const rawWindowMinutes = slot.raw.window_minutes ?? slot.raw.windowDurationMins;
    const windowMinutes = typeof rawWindowMinutes === 'number' && Number.isFinite(rawWindowMinutes)
      ? rawWindowMinutes
      : null;
    const window: LimitsWindow = {
      usedPercent: toPercent(slot.raw.used_percent ?? slot.raw.usedPercent),
      resetsAt: toEpochMs(slot.raw.resets_at ?? slot.raw.resetsAt),
      windowMinutes,
    };

    if (windowMinutes === 300) result.fiveHour = window;
    else if (windowMinutes === 10080) result.weekly = window;
    // Preserve compatibility with older two-slot events that omitted duration.
    // A lone durationless slot stays hidden rather than receiving a false label.
    else if (windowMinutes === null && populatedSlots.length === 2) result[slot.legacyTarget] = window;
  }

  return result;
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
  // Anthropic's wire name predates the Fable product name. Claude's own client
  // still reads `seven_day_sonnet` for the model-specific weekly allowance.
  const modelWeekly = data?.seven_day_sonnet;
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
  snap.modelWeekly = {
    usedPercent: toPercent(modelWeekly?.utilization),
    resetsAt: toEpochMs(modelWeekly?.resets_at),
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
  const now = Date.now();
  if (state.claudeBackoffUntil > now) {
    snap.status = 'unavailable';
    snap.detail = `Claude usage is temporarily rate-limited; retrying after ${new Date(state.claudeBackoffUntil).toLocaleTimeString()}.`;
    return snap;
  }
  try {
    const res = await fetchWithTimeout(CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${creds.token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
      },
    }, CLAUDE_USAGE_TIMEOUT_MS, 'Claude usage request');
    if (res.status === 401 || res.status === 403) {
      // Token expired/invalid — Claude Code refreshes it on its next run.
      snap.status = 'unavailable';
      snap.detail = 'Claude OAuth token expired — run any Claude turn to refresh it.';
      return snap;
    }
    if (!res.ok) {
      if (res.status === 429) {
        state.claudeFailureCount += 1;
        const exponentialDelay = Math.min(
          CLAUDE_BACKOFF_MAX_MS,
          CLAUDE_BACKOFF_BASE_MS * (2 ** Math.max(0, state.claudeFailureCount - 1)),
        );
        state.claudeBackoffUntil = parseRetryAfter(res.headers.get('retry-after'), now) ?? now + exponentialDelay;
        snap.status = 'unavailable';
        snap.detail = `Claude usage endpoint rate-limited this refresh (HTTP 429); retrying after ${new Date(state.claudeBackoffUntil).toLocaleTimeString()}.`;
        return snap;
      }
      snap.status = 'error';
      snap.detail = `Usage endpoint returned HTTP ${res.status}.`;
      return snap;
    }
    state.claudeFailureCount = 0;
    state.claudeBackoffUntil = 0;
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
    snap.modelWeekly = {
      usedPercent: toPercent(data.seven_day_sonnet_used_percentage),
      resetsAt: toEpochMs(data.seven_day_sonnet_resets_at),
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
// Codex — live app-server rate limits + rollout fallback
// ---------------------------------------------------------------------------

/** Map the current Codex app-server response without requiring a live process. */
export function mapCodexAppServerRateLimits(data: any): ProviderLimitsSnapshot {
  const snap = baseSnapshot('codex', 'Codex app-server account/rateLimits/read');
  const byLimitId = data?.rateLimitsByLimitId;
  const rateLimits = byLimitId?.codex
    ?? (byLimitId && typeof byLimitId === 'object'
      ? Object.values(byLimitId).find((value: any) => value?.limitId === 'codex')
      : null)
    ?? data?.rateLimits;

  if (!rateLimits || typeof rateLimits !== 'object') {
    snap.status = 'unavailable';
    snap.detail = 'Codex app-server returned no account rate-limit data.';
    return snap;
  }

  snap.updatedAt = Date.now();
  const planType = rateLimits.planType ?? rateLimits.plan_type;
  snap.planType = typeof planType === 'string' ? planType : null;
  const windows = mapCodexRateLimitWindows(rateLimits);
  snap.fiveHour = windows.fiveHour;
  snap.weekly = windows.weekly;

  if (snap.fiveHour.usedPercent === null && snap.weekly.usedPercent === null) {
    snap.status = 'unavailable';
    snap.detail = 'Codex app-server returned no usable rate-limit window.';
    return snap;
  }

  snap.status = 'available';
  return snap;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface JsonLineResponseOptions {
  timeoutMs?: number;
  timeoutMessage?: string;
  maxChars?: number;
}

export async function readJsonLineResponse(
  stream: ReadableStream<Uint8Array>,
  responseId: number,
  options: JsonLineResponseOptions = {},
): Promise<any> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let observedChars = 0;
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? -1) >= 0
    ? Math.floor(options.timeoutMs!)
    : CODEX_APP_SERVER_TIMEOUT_MS;
  const maxChars = Number.isFinite(options.maxChars) && (options.maxChars ?? 0) > 0
    ? Math.floor(options.maxChars!)
    : CODEX_APP_SERVER_MAX_RESPONSE_CHARS;
  const timeoutError = new Error(options.timeoutMessage
    || `Timed out reading Codex app-server response ${responseId}.`);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });

  const parseLine = (line: string): any | null => {
    if (!line.trim()) return null;
    try {
      const message = JSON.parse(line);
      return message?.id === responseId ? message : null;
    } catch {
      return null;
    }
  };

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) {
        buffered += decoder.decode();
        const response = parseLine(buffered.replace(/\r$/, ''));
        if (response) return response;
        throw new Error(`Codex app-server closed before response ${responseId}.`);
      }

      const decoded = decoder.decode(value, { stream: true });
      observedChars += decoded.length;
      if (observedChars > maxChars) {
        throw new Error(`Codex app-server exceeded ${maxChars} characters before response ${responseId}.`);
      }
      buffered += decoded;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const response = parseLine(line.replace(/\r$/, ''));
        if (response) return response;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
}

async function waitForProcessExit(
  proc: ReturnType<typeof safeSpawn>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const exited = proc.exited.then(() => true);
  const result = await Promise.race([exited, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

async function readCodexLimitsFromAppServer(): Promise<ProviderLimitsSnapshot> {
  const unavailable = baseSnapshot('codex', 'Codex app-server account/rateLimits/read');
  let proc: ReturnType<typeof safeSpawn> | null = null;
  let stderrPromise: Promise<string> | null = null;
  let stderrAbort: AbortController | null = null;

  try {
    const codexCommand = resolveCodexLaunchCommand(resolveCliBinary('codex'));
    proc = safeSpawn([...codexCommand, 'app-server', '--stdio'], {
      cwd: process.cwd(),
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: createCliEnv(),
    });
    stderrAbort = new AbortController();
    stderrPromise = drainStreamToString(proc.stderr, CODEX_APP_SERVER_STDERR_CHARS, stderrAbort.signal);

    proc.stdin.write(JSON.stringify({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: { name: 'agent-forge', title: 'Agent Forge', version: '1' },
        capabilities: null,
      },
    }) + '\n');

    const initialize = await readJsonLineResponse(proc.stdout, 1, {
      timeoutMs: CODEX_APP_SERVER_TIMEOUT_MS,
      timeoutMessage: 'Timed out initializing Codex app-server.',
    });
    if (initialize?.error) {
      throw new Error(initialize.error.message || 'Codex app-server initialization failed.');
    }

    proc.stdin.write([
      JSON.stringify({ method: 'initialized', params: {} }),
      JSON.stringify({ method: 'account/rateLimits/read', id: 2 }),
    ].join('\n') + '\n');

    const response = await readJsonLineResponse(proc.stdout, 2, {
      timeoutMs: CODEX_APP_SERVER_TIMEOUT_MS,
      timeoutMessage: 'Timed out reading Codex account rate limits.',
    });
    if (response?.error) {
      throw new Error(response.error.message || 'Codex rate-limit read failed.');
    }
    return mapCodexAppServerRateLimits(response?.result);
  } catch (e: any) {
    unavailable.status = 'error';
    unavailable.detail = `Live Codex rate-limit read failed: ${e?.message || String(e)}`;
    return unavailable;
  } finally {
    if (proc) {
      try { proc.stdin.end(); } catch {}
      if (!(await waitForProcessExit(proc, 1_500))) {
        await killProcessTree(proc);
        await waitForProcessExit(proc, 750);
      }
    }
    stderrAbort?.abort(new Error('Codex app-server collection finished.'));
    if (stderrPromise) {
      await withTimeout(stderrPromise, 250, 'Timed out draining Codex app-server stderr.').catch(() => '');
    }
  }
}

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

async function readCodexLimitsFromRollouts(): Promise<ProviderLimitsSnapshot> {
  const snap = baseSnapshot('codex', `rollout files → ${codexSessionsRoot()}`);
  try {
    const files = newestRolloutFiles(CODEX_FILE_SCAN_CAP);
    if (files.length === 0) {
      snap.status = 'unavailable';
      snap.detail = 'No Codex rollout files found. They appear after the first Codex CLI session.';
      return snap;
    }
    let latestEvent: any | null = null;
    let latestEventAt = -Infinity;
    for (const path of files) {
      const event = await lastRateLimitEvent(path);
      if (!event) continue;
      const eventAt = toEpochMs(event.timestamp) ?? 0;
      if (!latestEvent || eventAt > latestEventAt) {
        latestEvent = event;
        latestEventAt = eventAt;
      }
    }

    if (latestEvent) {
      const payload = latestEvent.payload;
      const rl = payload.rate_limits;
      snap.updatedAt = toEpochMs(latestEvent.timestamp);
      snap.planType = typeof rl.plan_type === 'string' ? rl.plan_type : null;
      const windows = mapCodexRateLimitWindows(rl);
      snap.fiveHour = windows.fiveHour;
      snap.weekly = windows.weekly;
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

async function readCodexLimits(): Promise<ProviderLimitsSnapshot> {
  // An explicit sessions-directory override means the caller wants the rollout
  // source (notably deterministic tests and offline fixtures).
  if (process.env.AI_HARNESS_CODEX_SESSIONS_DIR) {
    return readCodexLimitsFromRollouts();
  }

  const live = await readCodexLimitsFromAppServer();
  if (live.status === 'available') return live;

  const fallback = await readCodexLimitsFromRollouts();
  if (fallback.status === 'available' || fallback.status === 'stale') {
    fallback.detail = 'Live Codex rate-limit read unavailable; showing rollout fallback.';
    return fallback;
  }
  return live;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const limitsService = {
  async refresh(broadcastIt = true): Promise<LimitsSnapshot> {
    if (!state.refreshPromise) {
      state.refreshPromise = (async () => {
        // Providers are independent — one failing source must not blank the other.
        const [nextClaude, nextCodex] = await Promise.all([readClaudeLimits(), readCodexLimits()]);
        const snapshot: LimitsSnapshot = {
          providers: {
            claude: mergeProviderLimits(state.snapshot?.providers.claude, nextClaude),
            codex: mergeProviderLimits(state.snapshot?.providers.codex, nextCodex),
          },
          refreshIntervalMs: LIMITS_REFRESH_INTERVAL_MS,
          nextRefreshAt: state.nextRefreshAt || Date.now() + LIMITS_REFRESH_INTERVAL_MS,
        };
        state.snapshot = snapshot;
        return snapshot;
      })().finally(() => {
        state.refreshPromise = null;
      });
    }
    const snapshot = await state.refreshPromise;
    if (broadcastIt) broadcast({ type: 'limits_snapshot', snapshot });
    return snapshot;
  },

  /** Cached snapshot for WS connect; kicks off a first read if none exists yet. */
  getSnapshot(): LimitsSnapshot | null {
    return state.snapshot;
  },

  /** Start the one-minute refresh loop. Idempotent (HMR-safe). */
  start(): void {
    if (state.timer) clearInterval(state.timer);
    state.nextRefreshAt = Date.now() + LIMITS_REFRESH_INTERVAL_MS;
    state.timer = setInterval(() => {
      state.nextRefreshAt = Date.now() + LIMITS_REFRESH_INTERVAL_MS;
      limitsService.refresh().catch(e => console.error('[limits] scheduled refresh failed:', e));
    }, LIMITS_REFRESH_INTERVAL_MS);
    limitsService.refresh().catch(e => console.error('[limits] initial refresh failed:', e));
  },

  stop(): void {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.nextRefreshAt = 0;
  },

  /** Tests only. Does not stop a production timer. */
  resetCacheForTests(): void {
    state.snapshot = null;
    state.refreshPromise = null;
    state.claudeBackoffUntil = 0;
    state.claudeFailureCount = 0;
  },
};
