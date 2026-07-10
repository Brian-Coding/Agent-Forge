import { expect, test } from 'bun:test';
import { STATIC_AGENT_DEFINITIONS, type ModelOption } from '../agents/agent-kinds';
import { buildCodexDefinition } from './model-catalog.service';

test('Codex discovery puts the GPT-5.6 family ahead of GPT-5.5 and keeps descriptions', () => {
  const discovered: ModelOption[] = [
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'CLI Sol description' },
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
