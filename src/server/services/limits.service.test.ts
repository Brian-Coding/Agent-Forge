import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { LIMITS_REFRESH_INTERVAL_MS, limitsService, mapClaudeUsageResponse, mapCodexRateLimitWindows } from './limits.service';

// Parser regression net for the Limits tab: feeds a synthetic Claude bridge
// file and a synthetic Codex rollout tree through refresh() via env overrides.

let dir: string;
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
  const claudePath = join(dir, 'claude-limits.json');
  writeFileSync(claudePath, JSON.stringify({
    updated_at: Date.now(),
    model: 'Fable 5',
    context_used_percentage: 32,
    five_hour_used_percentage: 41.2,
    five_hour_resets_at: '2026-07-10T02:00:00Z',
    seven_day_used_percentage: 18.6,
    seven_day_resets_at: 1784046280, // epoch seconds — parser must normalize
  }));
  process.env.AI_HARNESS_CLAUDE_LIMITS_JSON = claudePath;

  // Codex rollout tree: sessions/YYYY/MM/DD/rollout-*.jsonl
  const dayDir = join(dir, 'sessions', '2026', '07', '09');
  mkdirSync(dayDir, { recursive: true });
  const lines = [
    JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'agent_message', text: 'hi' } }),
    JSON.stringify({
      timestamp: new Date().toISOString(),
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
  process.env.AI_HARNESS_CODEX_SESSIONS_DIR = join(dir, 'sessions');
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
  process.env.AI_HARNESS_CLAUDE_LIMITS_JSON = join(dir, 'missing.json');
  process.env.AI_HARNESS_CODEX_SESSIONS_DIR = join(dir, 'no-sessions');
  const snapshot = await limitsService.refresh(false);
  expect(snapshot.providers.claude.status).toBe('unavailable');
  expect(snapshot.providers.codex.status).toBe('unavailable');
  expect(snapshot.providers.claude.detail).toContain('statusLine');
});
