import { expect, test } from 'bun:test';
import { resolveAgentModel, resolveAgentReasoningLevel } from '../agents/registry';
import { UI_ATLAS_AGENT_PROFILE } from './atlas.service';
import { QA_TESTER_AGENT_PROFILE } from './qa.service';
import { CODEX_XHIGH_SPECIALIST_PROFILE } from './specialist-agent-profile';

test('UI Atlas uses Codex GPT-5.6 Sol with xhigh reasoning', () => {
  expect(UI_ATLAS_AGENT_PROFILE).toEqual({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoningLevel: 'xhigh',
  });
  expect(resolveAgentModel(UI_ATLAS_AGENT_PROFILE.provider, UI_ATLAS_AGENT_PROFILE.model))
    .toBe('gpt-5.6-sol');
  expect(resolveAgentReasoningLevel(
    UI_ATLAS_AGENT_PROFILE.provider,
    UI_ATLAS_AGENT_PROFILE.model,
    UI_ATLAS_AGENT_PROFILE.reasoningLevel,
  )).toBe('xhigh');
});

test('QA Tester shares the Codex GPT-5.6 Sol xhigh specialist profile', () => {
  expect(QA_TESTER_AGENT_PROFILE).toBe(CODEX_XHIGH_SPECIALIST_PROFILE);
  expect(QA_TESTER_AGENT_PROFILE).toEqual({
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoningLevel: 'xhigh',
  });
  expect(resolveAgentModel(QA_TESTER_AGENT_PROFILE.provider, QA_TESTER_AGENT_PROFILE.model))
    .toBe('gpt-5.6-sol');
  expect(resolveAgentReasoningLevel(
    QA_TESTER_AGENT_PROFILE.provider,
    QA_TESTER_AGENT_PROFILE.model,
    QA_TESTER_AGENT_PROFILE.reasoningLevel,
  )).toBe('xhigh');
});
