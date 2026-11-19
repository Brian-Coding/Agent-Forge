import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_DEFINITIONS, getAgentDefinition, STATIC_AGENT_DEFINITIONS, type ModelOption } from '../agents/agent-kinds';
import { safeRemoveTree } from './safe-filesystem.mjs';
import {
  buildCodexDefinition,
  buildClaudeDefinition,
  observeProviderModel,
  parseClaudeModelDiscovery,
  parseCodexModelDiscovery,
  readConfiguredCodexModel,
  stabilizeCodexModelDiscovery,
} from './model-catalog.service';

test('observing catalog Claude IDs preserves every label, description, and position', () => {
  const original = AGENT_DEFINITIONS.claude;
  const observed: Set<string> = (globalThis as any).__observedProviderModels.claude;
  const previous = [...observed];
  try {
    observed.clear();
    AGENT_DEFINITIONS.claude = { ...STATIC_AGENT_DEFINITIONS.claude, models: [
      ...STATIC_AGENT_DEFINITIONS.claude.models,
      { id: 'claude-preview-8-1', label: 'Preview 8.1', description: 'Discovered catalog description' },
    ] };
    const before = structuredClone(AGENT_DEFINITIONS.claude);
    for (const model of before.models) {
      expect(observeProviderModel('claude', model.id + '[1m]')).toBe(false);
    }
    expect(AGENT_DEFINITIONS.claude).toEqual(before);
    expect(observed.size).toBe(0);
  } finally {
    AGENT_DEFINITIONS.claude = original;
    observed.clear();
    for (const id of previous) observed.add(id);
  }
});

test('unknown Claude models append in observation order with readable versions and no date suffix', () => {
  const original = AGENT_DEFINITIONS.claude;
  const observed: Set<string> = (globalThis as any).__observedProviderModels.claude;
  const previous = [...observed];
  try {
    observed.clear();
    const known = { id: 'claude-preview-8', label: 'Preview 8', description: 'Catalog entry' };
    AGENT_DEFINITIONS.claude = { ...original, models: [known] };
    for (const id of ['claude-sonnet-5-5', 'claude-haiku-4-5-20251001']) {
      expect(observeProviderModel('claude', id + '[1m]')).toBe(true);
      expect(observeProviderModel('claude', id)).toBe(false);
    }
    expect(AGENT_DEFINITIONS.claude.models).toEqual([
      known,
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Observed from this provider at runtime.' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Observed from this provider at runtime.' },
    ]);
  } finally {
    AGENT_DEFINITIONS.claude = original;
    observed.clear();
    for (const id of previous) observed.add(id);
  }
});

test('catalog refresh promotes discovered observations and keeps static catalog entries ahead of unknowns', () => {
  const observed: Set<string> = (globalThis as any).__observedProviderModels.claude;
  const previous = [...observed];
  try {
    observed.clear();
    for (const id of ['claude-sonnet-5-5', 'claude-preview-8-1', 'claude-preview-8-2']) observed.add(id);
    const discovered = [{ id: 'claude-preview-8-1', label: 'Preview Eight', description: 'From discovery' }];
    expect(buildClaudeDefinition(discovered).models).toEqual([
      ...discovered,
      ...STATIC_AGENT_DEFINITIONS.claude.models,
      { id: 'claude-preview-8-2', label: 'Preview 8.2', description: 'Observed from this provider at runtime.' },
    ]);
    expect(buildClaudeDefinition([]).models.slice(0, STATIC_AGENT_DEFINITIONS.claude.models.length)).toEqual([...STATIC_AGENT_DEFINITIONS.claude.models]);
  } finally {
    observed.clear();
    for (const id of previous) observed.add(id);
  }
});

test('valid Claude models observed through OAuth CLI runs become selectable', () => {
  const modelId = `claude-opus-5-${randomUUID()}[1m]`;
  const normalizedId = modelId.replace(/\[[^\]]+\]$/, '');
  expect(observeProviderModel('claude', modelId)).toBe(true);
  expect(getAgentDefinition('claude').models.some(model => model.id === normalizedId)).toBe(true);
  expect(observeProviderModel('claude', '<synthetic>')).toBe(false);
  expect(getAgentDefinition('claude').models.some(model => model.id === '<synthetic>')).toBe(false);
});

test('Codex discovery preserves CLI order and capabilities, defaulting to its top model', () => {
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
    {
      id: 'gpt-6-astra',
      label: 'GPT-6-Astra',
      description: 'CLI Astra description',
      supportedReasoningLevels: ['medium', 'high'],
      defaultReasoningLevel: 'high',
    },
  ];

  const definition = buildCodexDefinition(discovered, true);

  expect(definition.models.map(model => model.id)).toEqual([
    'gpt-5.5',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-6-astra',
  ]);
  expect(definition.models[3]?.label).toBe('GPT-6 Astra');
  expect(definition.models[3]?.description).toBe('CLI Astra description');
  expect(definition.models[3]?.supportedReasoningLevels).toEqual(['medium', 'high']);
  expect(definition.models[3]?.defaultReasoningLevel).toBe('high');
  expect(definition.models[1]?.label).toBe('GPT-5.6 Sol');
  expect(definition.models[1]?.description).toBe('CLI Sol description');
  expect(definition.models[1]?.supportedReasoningLevels).toContain('max');
  expect(definition.models[1]?.supportedReasoningLevels).toContain('ultra');
  expect(definition.models[1]?.defaultReasoningLevel).toBe('medium');
  expect(definition.defaultModel).toBe('gpt-5.5');
});

test('Codex catalog respects CLI priorities across generations and hides unlisted models', () => {
  const discovered = parseCodexModelDiscovery({ models: [
    { slug: 'gpt-6-astra', priority: 4, visibility: 'list' },
    { slug: 'gpt-5.6-sol', priority: 7, visibility: 'list' },
    { slug: 'gpt-6.1-sol', priority: 3, visibility: 'list' },
    { slug: 'gpt-6.1-terra', priority: 1, visibility: 'list' },
    { slug: 'gpt-reserve', priority: 0, visibility: 'hide' },
    { slug: 'codex-auto-review', priority: 2, visibility: 'hide' },
    { slug: 'unsupported', priority: 0, visibility: 'list', supported_in_api: false },
  ] });
  const definition = buildCodexDefinition(discovered, true);
  expect(definition.models.map(model => model.id)).toEqual([
    'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-sol',
  ]);
  expect(definition.defaultModel).toBe('gpt-6.1-terra');
});

test('runtime Codex observations cannot reorder the catalog or reveal hidden models', () => {
  const original = AGENT_DEFINITIONS.codex;
  try {
    AGENT_DEFINITIONS.codex = buildCodexDefinition([
      { id: 'gpt-6.1-terra', label: 'Terra' }, { id: 'gpt-6.1-sol', label: 'Sol' },
    ], true);
    const expected = structuredClone(AGENT_DEFINITIONS.codex);
    observeProviderModel('codex', 'gpt-6.1-sol');
    observeProviderModel('codex', 'codex-auto-review');
    expect(AGENT_DEFINITIONS.codex).toEqual(expected);
  } finally {
    AGENT_DEFINITIONS.codex = original;
  }
});

test('successful Codex discovery does not append unsupported static models', () => {
  const definition = buildCodexDefinition([
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
  ], true);

  expect(definition.models.map(model => model.id)).toEqual(['gpt-5.5', 'gpt-5.4']);
  expect(definition.models.some(model => model.id === 'gpt-5.6-sol')).toBe(false);
  expect(definition.models.some(model => model.id === 'gpt-6-astra')).toBe(false);
});

test('Codex defaults to the configured visible model, otherwise the CLI top model', () => {
  const models = [{ id: 'gpt-6.1-terra', label: 'Terra' }, { id: 'gpt-6.1-sol', label: 'Sol' }];
  expect(buildCodexDefinition(models, true, 'gpt-6.1-sol').defaultModel).toBe('gpt-6.1-sol');
  for (const configured of [undefined, 'unavailable', 'codex-auto-review']) {
    expect(buildCodexDefinition(models, true, configured).defaultModel).toBe('gpt-6.1-terra');
  }
  expect(buildCodexDefinition([], false).defaultModel).toBe('gpt-6-astra');
  expect(buildCodexDefinition([], false, 'gpt-5.6-sol').defaultModel).toBe('gpt-5.6-sol');
});

test('Codex model preference reads only the top-level model from an isolated config', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'forge-model-config-'));
  const home = join(fixtureRoot, 'home');
  await mkdir(home);
  try {
    expect(await readConfiguredCodexModel(home)).toBeUndefined();
    await Bun.write(join(home, 'config.toml'), 'model = "gpt-6.1-sol" # preference\n[profiles.example]\nmodel = "profile-model"\n');
    expect(await readConfiguredCodexModel(home)).toBe('gpt-6.1-sol');
    for (const source of ['model = 42', 'model = " "', 'model = [', '[profiles.example]\nmodel = "profile-model"']) {
      await Bun.write(join(home, 'config.toml'), source);
      expect(await readConfiguredCodexModel(home)).toBeUndefined();
    }
  } finally {
    await safeRemoveTree({ targetPath: home, allowedRoot: fixtureRoot, allowNonEmpty: true, mode: 'delete', permanent: true, reason: 'Remove isolated model config fixture' });
  }
});

test('failed Codex discovery includes Astra in the static fallback', () => {
  const definition = buildCodexDefinition([], false);

  expect(definition.models).toEqual(STATIC_AGENT_DEFINITIONS.codex.models);
  expect(definition.models.slice(0, 3).map(model => model.id)).toEqual([
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
  ]);
});

test('Codex discovery retries a successful stale cold-start catalog once', async () => {
  const stale = {
    models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
    succeeded: true,
  };
  const refreshed = {
    models: [
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    ],
    succeeded: true,
  };
  let attempts = 0;

  const result = await stabilizeCodexModelDiscovery(stale, async () => {
    attempts++;
    return refreshed;
  });

  expect(attempts).toBe(1);
  expect(result).toEqual(refreshed);
});

test('Codex discovery keeps the first usable catalog if its stabilization retry fails', async () => {
  const stale = {
    models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
    succeeded: true,
  };

  const result = await stabilizeCodexModelDiscovery(stale, async () => ({
    models: [],
    succeeded: false,
  }));

  expect(result).toEqual(stale);
});

test('Codex discovery does not retry a catalog that already includes Astra', async () => {
  const current = {
    models: [{ id: 'gpt-6-astra', label: 'GPT-6 Astra' }],
    succeeded: true,
  };
  let attempts = 0;

  const result = await stabilizeCodexModelDiscovery(current, async () => {
    attempts++;
    return { models: [], succeeded: false };
  });

  expect(attempts).toBe(0);
  expect(result).toEqual(current);
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
