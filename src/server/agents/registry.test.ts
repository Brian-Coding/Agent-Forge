import { test, expect } from 'bun:test';
import { resolveAgentModel } from './registry';
import { stripModelTier } from './agent-kinds';

// Regression net for the "harness ran Opus while the UI said Fable" incident
// (2026-07-01). The root cause was a client display fallback, but this function
// is the server-side contract that decides which model the CLI is actually
// spawned with, so it must never silently swap a validly-requested model.

test('resolveAgentModel passes through a requested model that is in the catalog', () => {
  // Fable is a real catalog entry — selecting it must reach the CLI verbatim,
  // never get downgraded to the default.
  expect(resolveAgentModel('claude', 'claude-fable-5')).toBe('claude-fable-5');
  expect(resolveAgentModel('codex', 'gpt-5.4')).toBe('gpt-5.4');
});

test('resolveAgentModel falls back to the provider default for a model outside the catalog', () => {
  // Phantom ids are deliberately NOT passed through — the API silently
  // downgrades some (claude-sonnet-5 → claude-sonnet-4-6) and hard-errors
  // others (claude-mythos-5, restricted access). The fallback is no longer
  // silent: chat.service emits a system message whenever the resolved model
  // differs from the configured one.
  expect(resolveAgentModel('claude', 'claude-sonnet-5')).toBe('claude-opus-4-8');
  expect(resolveAgentModel('claude', 'totally-made-up-model')).toBe('claude-opus-4-8');
  expect(resolveAgentModel('codex', 'totally-made-up-model')).toBe('gpt-5.5');
});

test('resolveAgentModel falls back to the provider default when no model is requested', () => {
  // An unset model must resolve to the SAME default the UI now displays, so the
  // selector and the spawned CLI can never disagree for a fresh agent.
  expect(resolveAgentModel('claude', undefined)).toBe('claude-opus-4-8');
  expect(resolveAgentModel('claude', '')).toBe('claude-opus-4-8');
  expect(resolveAgentModel('codex', undefined)).toBe('gpt-5.5');
});

test('stripModelTier removes only a trailing [tier] suffix', () => {
  // The mismatch latch compares tier-stripped ids: opus-4-8 vs opus-4-8[1m] is
  // the same model at a different context tier — NOT a mismatch. Fable vs Opus
  // is a mismatch regardless of tier (the 2026-07-01 silent substitution).
  expect(stripModelTier('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
  expect(stripModelTier('claude-opus-4-8')).toBe('claude-opus-4-8');
  expect(stripModelTier('claude-fable-5[1m]')).toBe('claude-fable-5');
  expect(stripModelTier('gpt-5.5')).toBe('gpt-5.5');
  expect(stripModelTier(stripModelTier('claude-opus-4-8[1m]'))).toBe('claude-opus-4-8');
});
