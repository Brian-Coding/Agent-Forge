import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getAgentDefinition, STATIC_AGENT_DEFINITIONS, type ModelOption } from '../agents/agent-kinds';
import {
  buildCodexDefinition,
  observeProviderModel,
  parseClaudeModelDiscovery,
  parseCodexModelDiscovery,
} from './model-catalog.service';

test('valid Claude models observed through OAuth CLI runs become selectable', () => {
  const modelId = `claude-opus-5-${randomUUID()}[1m]`;
  const normalizedId = modelId.replace(/\[[^\]]+\]$/, '');
  expect(observeProviderModel('claude', modelId)).toBe(true);
  expect(getAgentDefinition('claude').models.some(model => model.id === normalizedId)).toBe(true);
  expect(observeProviderModel('claude', '<synthetic>')).toBe(false);
  expect(getAgentDefinition('claude').models.some(model => model.id === '<synthetic>')).toBe(false);
});

test('Codex discovery puts the GPT-5.6 family ahead of GPT-5.5 and keeps descriptions', () => {
  const discovered: ModelOption[] = [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    {
      id: 'gpt-5.6-sol',
      label: 'GPT-5.6-Sol',
      description: 'CLI Sol description',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningLevel: 'medium',
    },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'CLI Terra description' },
  ];

  const definition = buildCodexDefinition(discovered, true);

  expect(definition.models.map(model => model.id)).toEqual([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.5',
  ]);
  expect(definition.models[0]?.label).toBe('GPT-5.6 Sol');
  expect(definition.models[0]?.description).toBe('CLI Sol description');
  expect(definition.models[0]?.supportedReasoningLevels).toContain('max');
  expect(definition.models[0]?.supportedReasoningLevels).toContain('ultra');
  expect(definition.models[0]?.defaultReasoningLevel).toBe('medium');
  expect(definition.defaultModel).toBe('gpt-5.6-sol');
});

test('successful Codex discovery does not append unsupported static models', () => {
  const definition = buildCodexDefinition([
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
  ], true);

  expect(definition.models.map(model => model.id)).toEqual(['gpt-5.5', 'gpt-5.4']);
  expect(definition.models.some(model => model.id === 'gpt-5.6-sol')).toBe(false);
});

test('failed Codex discovery uses the static Sol and Terra fallback', () => {
  const definition = buildCodexDefinition([], false);

  expect(definition.models).toEqual(STATIC_AGENT_DEFINITIONS.codex.models);
  expect(definition.models.slice(0, 2).map(model => model.id)).toEqual([
    'gpt-5.6-sol',
    'gpt-5.6-terra',
  ]);
});

test('model discovery rejects malformed payloads and bounds hostile fields', () => {
  expect(parseCodexModelDiscovery(null)).toEqual([]);
  expect(parseCodexModelDiscovery({ models: 'not-an-array' })).toEqual([]);
  const codex = parseCodexModelDiscovery({
    models: [{
      slug: `gpt-${'x'.repeat(500)}`,
      display_name: 'Model',
      description: 'd'.repeat(5_000),
      visibility: 'list',
      supported_in_api: true,
      supported_reasoning_levels: Array.from({ length: 100 }, (_, index) => `level-${index}`),
    }],
  });
  expect(codex[0]?.id.length).toBeLessThanOrEqual(200);
  expect(codex[0]?.description?.length).toBeLessThanOrEqual(2_000);
  expect(codex[0]?.supportedReasoningLevels).toHaveLength(32);

  expect(parseClaudeModelDiscovery({ data: [{}] })).toEqual([]);
  expect(parseClaudeModelDiscovery({ data: [{ id: 'claude-fixture', display_name: 'Fixture' }] }))
    .toEqual([{ id: 'claude-fixture', label: 'Fixture' }]);
});
