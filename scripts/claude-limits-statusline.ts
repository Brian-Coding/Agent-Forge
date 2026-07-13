#!/usr/bin/env bun
/**
 * Claude Code statusLine hook → Agent Forge Limits bridge.
 *
 * Claude Code pipes a session-status JSON object to the statusLine command on
 * stdin (docs: https://docs.anthropic.com/en/docs/claude-code/statusline).
 * This script extracts the rate-limit fields, writes them atomically to
 * `~/.claude/claude-code-limits.json` (override with the
 * AI_HARNESS_CLAUDE_LIMITS_JSON env var), and prints a short status line back
 * for the Claude Code footer.
 *
 * Wire-up (in ~/.claude/settings.json):
 *   "statusLine": { "type": "command", "command": "bun \"<path-to>/scripts/claude-limits-statusline.ts\"" }
 *
 * Agent Forge's limits.service.ts reads the JSON file read-only every minute.
 * Note: rate_limits is only present for Claude Pro/Max subscriptions and only
 * after the first API response of a session — missing fields are normal.
 */
import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
import { mkdirSync, renameSync, writeFileSync } from 'fs';

let data: any = {};
try {
  data = JSON.parse(await Bun.stdin.text());
} catch {
  console.log('limits: no statusline JSON');
  process.exit(0);
}

const rate = data?.rate_limits ?? {};
const five = rate?.five_hour ?? {};
const week = rate?.seven_day ?? {};

const out = {
  updated_at: Date.now(),
  model: data?.model?.display_name ?? data?.model?.id ?? null,
  context_used_percentage: data?.context_window?.used_percentage ?? null,
  five_hour_used_percentage: five?.used_percentage ?? null,
  five_hour_resets_at: five?.resets_at ?? null,
  seven_day_used_percentage: week?.used_percentage ?? null,
  seven_day_resets_at: week?.resets_at ?? null,
};

const path = process.env.AI_HARNESS_CLAUDE_LIMITS_JSON || join(homedir(), '.claude', 'claude-code-limits.json');
try {
  mkdirSync(dirname(path), { recursive: true });
  // Atomic-ish write: temp file in the same directory, then rename over.
  const tmp = join(dirname(path), `.limits-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, path);
} catch (e) {
  // Never break the status line over a bridge-file hiccup.
}

const parts: string[] = [];
if (out.model) parts.push(String(out.model));
if (typeof out.five_hour_used_percentage === 'number') parts.push(`5h ${Math.round(out.five_hour_used_percentage)}%`);
if (typeof out.seven_day_used_percentage === 'number') parts.push(`7d ${Math.round(out.seven_day_used_percentage)}%`);
if (typeof out.context_used_percentage === 'number') parts.push(`ctx ${Math.round(out.context_used_percentage)}%`);
console.log(parts.length ? parts.join(' | ') : 'limits pending');
