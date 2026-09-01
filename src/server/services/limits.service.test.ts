import { test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  LIMITS_REFRESH_INTERVAL_MS,
  chooseCodexLimits,
  limitsService,
  mapClaudeUsageResponse,
  mapCodexAppServerRateLimits,
  mapCodexRateLimitWindows,
  mergeProviderLimits,
  parseRetryAfter,
  pickCodexAccountRateLimits,
  preferCodexRateLimitEvent,
  readJsonLineResponse,
  selectClaudeModelWeekly,
  selectClaudeUsageWindow,
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
    seven_day_sonnet_used_percentage: 49.2,
    seven_day_sonnet_resets_at: '2026-07-12T02:00:00Z',
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

  // A newer Spark / codex_bengalfox event at 0% must not hide the account Codex windows.
  const sparkPath = join(dayDir, 'rollout-2026-07-09T16-00-00-spark.jsonl');
  writeFileSync(sparkPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { total_tokens: 10 }, model_context_window: 100 },
      rate_limits: {
        limit_id: 'codex_bengalfox',
        primary: { used_percent: 0, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        secondary: { used_percent: 0, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 },
        plan_type: null,
      },
    },
  }) + '\n');
  const sparkMtime = new Date(Date.now() + 120_000);
  utimesSync(sparkPath, sparkMtime, sparkMtime);

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
    seven_day_sonnet: { utilization: 49, resets_at: '2026-07-12T02:00:00.000Z' },
  }, 'max');
  expect(snap.status).toBe('available');
  expect(snap.planType).toBe('max');
  expect(snap.fiveHour.usedPercent).toBe(38);
  expect(snap.fiveHour.windowMinutes).toBe(300);
  expect(snap.fiveHour.resetsAt).toBe(Date.parse('2026-07-10T04:50:00.000Z'));
  expect(snap.weekly.usedPercent).toBe(16);
  expect(snap.weekly.resetsAt).toBe(Date.parse('2026-07-12T02:00:00.000Z'));
  expect(snap.modelWeekly.usedPercent).toBe(49);
  expect(snap.modelWeekly.resetsAt).toBe(Date.parse('2026-07-12T02:00:00.000Z'));
});

test('mapClaudeUsageResponse treats empty windows as unavailable so merge can keep last good data', () => {
  const snap = mapClaudeUsageResponse({}, null);
  expect(snap.status).toBe('unavailable');
  expect(snap.detail).toContain('no readable windows');
  expect(snap.fiveHour.usedPercent).toBeNull();
  expect(snap.weekly.usedPercent).toBeNull();
  expect(snap.modelWeekly.usedPercent).toBeNull();
});

test('mapClaudeUsageResponse reads 5-hour and 7-day from limits[] when flat keys are null', () => {
  const snap = mapClaudeUsageResponse({
    five_hour: null,
    seven_day: null,
    seven_day_sonnet: null,
    limits: [
      { kind: 'session', group: 'session', percent: 12, resets_at: '2026-08-18T04:10:00.000Z', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 41, resets_at: '2026-08-23T02:00:00.000Z', scope: null },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 65,
        resets_at: '2026-08-23T02:00:00.000Z',
        scope: { model: { id: null, display_name: 'Fable' } },
      },
    ],
  }, 'max');
  expect(snap.status).toBe('available');
  expect(snap.fiveHour.usedPercent).toBe(12);
  expect(snap.fiveHour.resetsAt).toBe(Date.parse('2026-08-18T04:10:00.000Z'));
  expect(snap.weekly.usedPercent).toBe(41);
  expect(snap.weekly.resetsAt).toBe(Date.parse('2026-08-23T02:00:00.000Z'));
  expect(snap.modelWeekly.usedPercent).toBe(65);
});

test('selectClaudeUsageWindow finds session and weekly_all entries', () => {
  const data = {
    limits: [
      { kind: 'session', percent: 9, resets_at: '2026-08-18T04:10:00.000Z' },
      { kind: 'weekly_all', percent: 22, resets_at: '2026-08-23T02:00:00.000Z' },
    ],
  };
  expect(selectClaudeUsageWindow(data, ['session'])).toEqual({
    usedPercent: 9,
    resetsAt: Date.parse('2026-08-18T04:10:00.000Z'),
  });
  expect(selectClaudeUsageWindow(data, ['weekly_all']).usedPercent).toBe(22);
  expect(selectClaudeUsageWindow({}, ['session']).usedPercent).toBeNull();
});

// Anthropic retired the flat `seven_day_sonnet` key: live responses now send it
// as null and carry the Fable weekly window as a scoped entry in `limits[]`.
// Reading only the old key silently blanked the Fable meter.
test('mapClaudeUsageResponse reads the Fable weekly window from the scoped limits array', () => {
  const snap = mapClaudeUsageResponse({
    five_hour: { utilization: 7, resets_at: '2026-08-18T04:10:00.000Z' },
    seven_day: { utilization: 33, resets_at: '2026-08-23T02:00:00.000Z' },
    seven_day_sonnet: null,
    limits: [
      { kind: 'session', group: 'session', percent: 7, resets_at: '2026-08-18T04:10:00.000Z', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 33, resets_at: '2026-08-23T02:00:00.000Z', scope: null },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 65,
        resets_at: '2026-08-23T02:00:00.000Z',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: true,
      },
    ],
  }, 'max');
  expect(snap.modelWeekly.usedPercent).toBe(65);
  expect(snap.modelWeekly.resetsAt).toBe(Date.parse('2026-08-23T02:00:00.000Z'));
  expect(snap.modelWeekly.windowMinutes).toBe(10080);
  // The unscoped weekly entry must not be mistaken for the model window.
  expect(snap.weekly.usedPercent).toBe(33);
});

test('selectClaudeModelWeekly prefers the scoped entry and falls back to the legacy key', () => {
  expect(selectClaudeModelWeekly({
    seven_day_sonnet: { utilization: 49, resets_at: '2026-07-12T02:00:00.000Z' },
    limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 65, resets_at: '2026-08-23T02:00:00.000Z' }],
  }).usedPercent).toBe(65);

  // Payload predating the limits array.
  expect(selectClaudeModelWeekly({
    seven_day_sonnet: { utilization: 49, resets_at: '2026-07-12T02:00:00.000Z' },
  })).toEqual({ usedPercent: 49, resetsAt: Date.parse('2026-07-12T02:00:00.000Z') });

  // Array present but carrying no scoped weekly window.
  expect(selectClaudeModelWeekly({
    seven_day_sonnet: null,
    limits: [{ kind: 'weekly_all', group: 'weekly', percent: 33, scope: null }],
  })).toEqual({ usedPercent: null, resetsAt: null });

  expect(selectClaudeModelWeekly({}).usedPercent).toBeNull();
  expect(selectClaudeModelWeekly(null).usedPercent).toBeNull();
});

test('Claude statusline bridge preserves the model-specific Fable weekly window', async () => {
  const outputPath = join(dir, 'statusline-fable-limits.json');
  const scriptPath = join(import.meta.dir, '../../../scripts/claude-limits-statusline.ts');
  const proc = Bun.spawn([process.execPath, scriptPath], {
    env: { ...process.env, AI_HARNESS_CLAUDE_LIMITS_JSON: outputPath },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(JSON.stringify({
    model: { display_name: 'Fable 5' },
    rate_limits: {
      five_hour: { used_percentage: 1, resets_at: '2026-08-14T01:00:00Z' },
      seven_day: { used_percentage: 28, resets_at: '2026-08-16T02:00:00Z' },
      seven_day_sonnet: { used_percentage: 49, resets_at: '2026-08-16T02:00:00Z' },
    },
  }));
  proc.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(stdout).toContain('Fable 7d 49%');

  const written = await Bun.file(outputPath).json();
  expect(written.seven_day_sonnet_used_percentage).toBe(49);
  expect(written.seven_day_sonnet_resets_at).toBe('2026-08-16T02:00:00Z');
});

test('limits refresh cadence is one minute', () => {
  expect(LIMITS_REFRESH_INTERVAL_MS).toBe(60_000);
});

test('transient provider errors retain the last successful usage snapshot', () => {
  const previous = mapClaudeUsageResponse({
    five_hour: { utilization: 44, resets_at: '2026-08-11T20:00:00Z' },
    seven_day: { utilization: 19, resets_at: '2026-08-17T20:00:00Z' },
    seven_day_sonnet: { utilization: 51, resets_at: '2026-08-17T20:00:00Z' },
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
  expect(merged.modelWeekly.usedPercent).toBe(51);
  expect(merged.detail).toContain('HTTP 429');
});

test('empty available Claude snapshots do not wipe the last successful usage', () => {
  const previous = mapClaudeUsageResponse({
    five_hour: { utilization: 44, resets_at: '2026-08-11T20:00:00Z' },
    seven_day: { utilization: 19, resets_at: '2026-08-17T20:00:00Z' },
    seven_day_sonnet: { utilization: 51, resets_at: '2026-08-17T20:00:00Z' },
  }, 'max');
  const emptyAvailable = {
    ...previous,
    status: 'available' as const,
    checkedAt: previous.checkedAt + 60_000,
    fiveHour: { usedPercent: null, resetsAt: null, windowMinutes: 300 },
    weekly: { usedPercent: null, resetsAt: null, windowMinutes: 10080 },
    modelWeekly: { usedPercent: null, resetsAt: null, windowMinutes: 10080 },
    contextUsedPercent: null,
    detail: null,
  };

  const merged = mergeProviderLimits(previous, emptyAvailable);
  expect(merged.status).toBe('stale');
  expect(merged.fiveHour.usedPercent).toBe(44);
  expect(merged.weekly.usedPercent).toBe(19);
  expect(merged.modelWeekly.usedPercent).toBe(51);
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

test('Codex app-server mapping prefers account windows over Spark zeros', () => {
  const spark = {
    limitId: 'codex_bengalfox',
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1785258177 },
    secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1785258177 },
  };
  const account = {
    limitId: 'codex',
    planType: 'pro',
    primary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: 1785258177 },
    secondary: null,
  };
  const picked = pickCodexAccountRateLimits({
    rateLimits: spark,
    rateLimitsByLimitId: { codex: account, codex_bengalfox: spark },
  });
  expect(picked.limitId).toBe('codex');

  const snap = mapCodexAppServerRateLimits({
    rateLimits: spark,
    rateLimitsByLimitId: { codex: account, codex_bengalfox: spark },
  });
  expect(snap.status).toBe('available');
  expect(snap.limitId).toBe('codex');
  expect(snap.planType).toBe('pro');
  expect(snap.fiveHour.usedPercent).toBeNull();
  expect(snap.weekly.usedPercent).toBe(26);
});

test('Codex live model-specific zeros yield to account rollout windows', () => {
  const live = mapCodexAppServerRateLimits({
    rateLimits: {
      limitId: 'codex_bengalfox',
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1785258177 },
      secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1785258177 },
    },
    rateLimitsByLimitId: null,
  });
  expect(live.limitId).toBe('codex_bengalfox');
  expect(live.fiveHour.usedPercent).toBe(0);

  const fallback = mapCodexAppServerRateLimits({
    rateLimits: {
      limitId: 'codex',
      planType: 'pro',
      primary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: 1785258177 },
      secondary: null,
    },
    rateLimitsByLimitId: null,
  });
  fallback.source = 'rollout files';

  const chosen = chooseCodexLimits(live, fallback);
  expect(chosen.weekly.usedPercent).toBe(26);
  expect(chosen.limitId).toBe('codex');
  expect(chosen.detail).toContain('model-specific');
});

test('preferCodexRateLimitEvent keeps account Codex over a later Spark zero event', () => {
  const account = {
    timestamp: '2026-08-29T13:27:33.000Z',
    payload: { rate_limits: { limit_id: 'codex', primary: { used_percent: 26, window_minutes: 10080 } } },
  };
  const spark = {
    timestamp: '2026-08-29T14:48:45.000Z',
    payload: {
      rate_limits: {
        limit_id: 'codex_bengalfox',
        primary: { used_percent: 0, window_minutes: 300 },
        secondary: { used_percent: 0, window_minutes: 10080 },
      },
    },
  };
  expect(preferCodexRateLimitEvent(account, spark)).toBe(account);
  expect(preferCodexRateLimitEvent(spark, account)).toBe(account);
});

test('limits refresh parses Claude bridge file and Codex rollout events', async () => {
  const snapshot = await limitsService.refresh(false);

  const claude = snapshot.providers.claude;
  expect(claude.status).toBe('available');
  expect(claude.model).toBe('Fable 5');
  expect(claude.fiveHour.usedPercent).toBeCloseTo(41.2, 1);
  expect(claude.weekly.usedPercent).toBeCloseTo(18.6, 1);
  expect(claude.modelWeekly.usedPercent).toBeCloseTo(49.2, 1);
  // ISO string and epoch-seconds forms both normalize to epoch ms
  expect(claude.fiveHour.resetsAt).toBe(Date.parse('2026-07-10T02:00:00Z'));
  expect(claude.weekly.resetsAt).toBe(1784046280 * 1000);
  expect(claude.modelWeekly.resetsAt).toBe(Date.parse('2026-07-12T02:00:00Z'));
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

test('Claude statusline bridge reads the Fable weekly window from a scoped limits array', async () => {
  const outputPath = join(dir, 'statusline-fable-scoped-limits.json');
  const scriptPath = join(import.meta.dir, '../../../scripts/claude-limits-statusline.ts');
  const proc = Bun.spawn([process.execPath, scriptPath], {
    env: { ...process.env, AI_HARNESS_CLAUDE_LIMITS_JSON: outputPath },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(JSON.stringify({
    model: { display_name: 'Fable 5' },
    rate_limits: {
      five_hour: { used_percentage: 7, resets_at: '2026-08-18T04:10:00Z' },
      seven_day: { used_percentage: 33, resets_at: '2026-08-23T02:00:00Z' },
      seven_day_sonnet: null,
      limits: [
        { kind: 'weekly_all', group: 'weekly', percent: 33, resets_at: '2026-08-23T02:00:00Z', scope: null },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 65,
          resets_at: '2026-08-23T02:00:00Z',
          scope: { model: { id: null, display_name: 'Fable' } },
        },
      ],
    },
  }));
  proc.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(stdout).toContain('Fable 7d 65%');

  const written = await Bun.file(outputPath).json();
  expect(written.seven_day_sonnet_used_percentage).toBe(65);
  expect(written.seven_day_sonnet_resets_at).toBe('2026-08-23T02:00:00Z');
});

test('Claude statusline bridge fills 5-hour and 7-day from limits[] when flat keys are missing', async () => {
  const outputPath = join(dir, 'statusline-limits-array-only.json');
  const scriptPath = join(import.meta.dir, '../../../scripts/claude-limits-statusline.ts');
  const proc = Bun.spawn([process.execPath, scriptPath], {
    env: { ...process.env, AI_HARNESS_CLAUDE_LIMITS_JSON: outputPath },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(JSON.stringify({
    model: { display_name: 'Fable 5' },
    rate_limits: {
      five_hour: null,
      seven_day: null,
      seven_day_sonnet: null,
      limits: [
        { kind: 'session', group: 'session', percent: 12, resets_at: '2026-08-18T04:10:00Z' },
        { kind: 'weekly_all', group: 'weekly', percent: 41, resets_at: '2026-08-23T02:00:00Z' },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 65,
          resets_at: '2026-08-23T02:00:00Z',
          scope: { model: { id: null, display_name: 'Fable' } },
        },
      ],
    },
  }));
  proc.stdin.end();

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe('');
  expect(stdout).toContain('5h 12%');
  expect(stdout).toContain('7d 41%');
  expect(stdout).toContain('Fable 7d 65%');

  const written = await Bun.file(outputPath).json();
  expect(written.five_hour_used_percentage).toBe(12);
  expect(written.seven_day_used_percentage).toBe(41);
  expect(written.seven_day_sonnet_used_percentage).toBe(65);
});
