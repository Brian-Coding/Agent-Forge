import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  LIMITS_REFRESH_INTERVAL_MS,
  limitsService,
  mapClaudeUsageResponse,
  mapCodexAppServerRateLimits,
  mapCodexRateLimitWindows,
  mergeProviderLimits,
  parseRetryAfter,
  readJsonLineResponse,
} from './limits.service';

// Parser regression net for the Limits tab: feeds a synthetic Claude bridge
// file and a synthetic Codex rollout tree through refresh() via env overrides.

let dir: string;
let claudeFixturePath: string;
let codexFixturePath: string;
const envBackup: Record<string, string | undefined> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'af-limits-'));
  envBackup.claude = process.env.AI_HARNESS_CLAUDE_LIMITS_JSON;
  envBackup.codex = process.env.AI_HARNESS_CODEX_SESSIONS_DIR;
  envBackup.creds = process.env.AI_HARNESS_CLAUDE_CREDENTIALS_JSON;
  // Point the OAuth credentials at a non-existent file so readClaudeLimits
  // falls back to the bridge file (no live network call in tests).
  process.env.AI_HARNESS_CLAUDE_CREDENTIALS_JSON = join(dir, 'no-credentials.json');

  // Claude bridge file (as written by scripts/claude-limits-statusline.ts)
  claudeFixturePath = join(dir, 'claude-limits.json');
  writeFileSync(claudeFixturePath, JSON.stringify({
    updated_at: Date.now(),
    model: 'Fable 5',
    context_used_percentage: 32,
    five_hour_used_percentage: 41.2,
    five_hour_resets_at: '2026-07-10T02:00:00Z',
    seven_day_used_percentage: 18.6,
    seven_day_resets_at: 1784046280, // epoch seconds — parser must normalize
  }));
  process.env.AI_HARNESS_CLAUDE_LIMITS_JSON = claudeFixturePath;

  // Codex rollout tree: sessions/YYYY/MM/DD/rollout-*.jsonl
  const dayDir = join(dir, 'sessions', '2026', '07', '09');
  mkdirSync(dayDir, { recursive: true });
  const currentEventAt = new Date(Date.now() - 60_000).toISOString();
  const lines = [
    JSON.stringify({ timestamp: currentEventAt, type: 'event_msg', payload: { type: 'agent_message', text: 'hi' } }),
    JSON.stringify({
      timestamp: currentEventAt,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { total_tokens: 129200 }, model_context_window: 258400 },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 3.0, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 },
          secondary: { used_percent: 6.0, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 },
          plan_type: 'prolite',
        },
      },
    }),
  ];
  writeFileSync(join(dayDir, 'rollout-2026-07-09T14-08-52-test.jsonl'), lines.join('\n') + '\n');

  // A long-lived session can have a newer file mtime while its last rate-limit
  // event is older. Event timestamps, not file mtimes, must win.
  const stalePath = join(dayDir, 'rollout-2026-07-09T15-00-00-stale.jsonl');
  writeFileSync(stalePath, JSON.stringify({
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: 10 }, model_context_window: 100 },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 63, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 },
        secondary: null,
        plan_type: 'prolite',
      },
    },
  }) + '\n');
  const futureMtime = new Date(Date.now() + 60_000);
  utimesSync(stalePath, futureMtime, futureMtime);
  codexFixturePath = join(dir, 'sessions');
  process.env.AI_HARNESS_CODEX_SESSIONS_DIR = codexFixturePath;
});

beforeEach(() => {
  process.env.AI_HARNESS_CLAUDE_CREDENTIALS_JSON = join(dir, 'no-credentials.json');
  process.env.AI_HARNESS_CLAUDE_LIMITS_JSON = claudeFixturePath;
  process.env.AI_HARNESS_CODEX_SESSIONS_DIR = codexFixturePath;
  limitsService.resetCacheForTests();
});

afterAll(() => {
  if (envBackup.claude === undefined) delete process.env.AI_HARNESS_CLAUDE_LIMITS_JSON;
  else process.env.AI_HARNESS_CLAUDE_LIMITS_JSON = envBackup.claude;
  if (envBackup.codex === undefined) delete process.env.AI_HARNESS_CODEX_SESSIONS_DIR;
  else process.env.AI_HARNESS_CODEX_SESSIONS_DIR = envBackup.codex;
  if (envBackup.creds === undefined) delete process.env.AI_HARNESS_CLAUDE_CREDENTIALS_JSON;
  else process.env.AI_HARNESS_CLAUDE_CREDENTIALS_JSON = envBackup.creds;
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('mapClaudeUsageResponse maps the /api/oauth/usage shape', () => {
  const snap = mapClaudeUsageResponse({
    five_hour: { utilization: 38, resets_at: '2026-07-10T04:50:00.000Z' },
    seven_day: { utilization: 16, resets_at: '2026-07-12T02:00:00.000Z' },
  }, 'max');
  expect(snap.status).toBe('available');
  expect(snap.planType).toBe('max');
  expect(snap.fiveHour.usedPercent).toBe(38);
  expect(snap.fiveHour.windowMinutes).toBe(300);
  expect(snap.fiveHour.resetsAt).toBe(Date.parse('2026-07-10T04:50:00.000Z'));
  expect(snap.weekly.usedPercent).toBe(16);
  expect(snap.weekly.resetsAt).toBe(Date.parse('2026-07-12T02:00:00.000Z'));
});

test('mapClaudeUsageResponse tolerates missing windows', () => {
  const snap = mapClaudeUsageResponse({}, null);
  expect(snap.status).toBe('available');
  expect(snap.fiveHour.usedPercent).toBeNull();
  expect(snap.weekly.usedPercent).toBeNull();
});

test('limits refresh cadence is one minute', () => {
  expect(LIMITS_REFRESH_INTERVAL_MS).toBe(60_000);
});

test('transient provider errors retain the last successful usage snapshot', () => {
  const previous = mapClaudeUsageResponse({
    five_hour: { utilization: 44, resets_at: '2026-08-11T20:00:00Z' },
    seven_day: { utilization: 19, resets_at: '2026-08-17T20:00:00Z' },
  }, 'max');
  const failed = {
    ...previous,
    status: 'unavailable' as const,
    checkedAt: previous.checkedAt + 60_000,
    fiveHour: { usedPercent: null, resetsAt: null, windowMinutes: null },
    weekly: { usedPercent: null, resetsAt: null, windowMinutes: null },
    detail: 'Claude usage endpoint rate-limited this refresh (HTTP 429).',
  };

  const merged = mergeProviderLimits(previous, failed);
  expect(merged.status).toBe('stale');
  expect(merged.fiveHour.usedPercent).toBe(44);
  expect(merged.weekly.usedPercent).toBe(19);
  expect(merged.detail).toContain('HTTP 429');
});

test('Retry-After supports both seconds and HTTP dates', () => {
  const now = Date.parse('2026-08-11T19:00:00Z');
  expect(parseRetryAfter('120', now)).toBe(now + 120_000);
  expect(parseRetryAfter('Tue, 11 Aug 2026 19:05:00 GMT', now)).toBe(now + 300_000);
  expect(parseRetryAfter('not-a-date', now)).toBeNull();
});

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('Codex app-server reader tolerates malformed and split JSON lines', async () => {
  const response = await readJsonLineResponse(byteStream([
    'not json\r\n{"id":99,"result":{}}\n{"i',
    'd":2,"result":{"ok":true}}\r\n',
  ]), 2, { timeoutMs: 100 });
  expect(response).toEqual({ id: 2, result: { ok: true } });
});

test('Codex app-server reader applies a hard deadline and output ceiling', async () => {
  const hanging = new ReadableStream<Uint8Array>({ start() {} });
  const startedAt = Date.now();
  await expect(readJsonLineResponse(hanging, 7, {
    timeoutMs: 10,
    timeoutMessage: 'fixture deadline',
  })).rejects.toThrow('fixture deadline');
  expect(Date.now() - startedAt).toBeLessThan(250);

  await expect(readJsonLineResponse(byteStream(['xxxxxxxxxxxxxxxx']), 7, {
    timeoutMs: 100,
    maxChars: 8,
  })).rejects.toThrow('exceeded 8 characters');
});

test('Codex maps a primary-only weekly limit by duration instead of slot position', () => {
  const windows = mapCodexRateLimitWindows({
    primary: { used_percent: 15, window_minutes: 10080, resets_at: 1784493552 },
    secondary: null,
  });

  expect(windows.fiveHour.usedPercent).toBeNull();
  expect(windows.fiveHour.windowMinutes).toBeNull();
  expect(windows.weekly.usedPercent).toBe(15);
  expect(windows.weekly.windowMinutes).toBe(10080);
  expect(windows.weekly.resetsAt).toBe(1784493552 * 1000);
});

test('Codex maps the live app-server camelCase rate-limit response', () => {
  const snap = mapCodexAppServerRateLimits({
    rateLimits: {
      limitId: 'codex',
      planType: 'prolite',
      primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1785258177 },
      secondary: null,
    },
    rateLimitsByLimitId: null,
  });

  expect(snap.status).toBe('available');
  expect(snap.source).toContain('account/rateLimits/read');
  expect(snap.planType).toBe('prolite');
  expect(snap.fiveHour.usedPercent).toBeNull();
  expect(snap.weekly.usedPercent).toBe(4);
  expect(snap.weekly.windowMinutes).toBe(10080);
  expect(snap.weekly.resetsAt).toBe(1785258177 * 1000);
});

test('limits refresh parses Claude bridge file and Codex rollout events', async () => {
  const snapshot = await limitsService.refresh(false);

  const claude = snapshot.providers.claude;
  expect(claude.status).toBe('available');
  expect(claude.model).toBe('Fable 5');
  expect(claude.fiveHour.usedPercent).toBeCloseTo(41.2, 1);
  expect(claude.weekly.usedPercent).toBeCloseTo(18.6, 1);
  // ISO string and epoch-seconds forms both normalize to epoch ms
  expect(claude.fiveHour.resetsAt).toBe(Date.parse('2026-07-10T02:00:00Z'));
  expect(claude.weekly.resetsAt).toBe(1784046280 * 1000);
  expect(claude.contextUsedPercent).toBe(32);

  const codex = snapshot.providers.codex;
  expect(codex.status).toBe('available');
  expect(codex.planType).toBe('prolite');
  expect(codex.fiveHour.usedPercent).toBe(3);
  expect(codex.fiveHour.windowMinutes).toBe(300);
  expect(codex.weekly.usedPercent).toBe(6);
  expect(codex.contextUsedPercent).toBeCloseTo(50, 0);
});

test('limits refresh reports unavailable sources without throwing', async () => {
  limitsService.resetCacheForTests();
  process.env.AI_HARNESS_CLAUDE_LIMITS_JSON = join(dir, 'missing.json');
  process.env.AI_HARNESS_CODEX_SESSIONS_DIR = join(dir, 'no-sessions');
  const snapshot = await limitsService.refresh(false);
  expect(snapshot.providers.claude.status).toBe('unavailable');
  expect(snapshot.providers.codex.status).toBe('unavailable');
  expect(snapshot.providers.claude.detail).toContain('statusLine');
});
