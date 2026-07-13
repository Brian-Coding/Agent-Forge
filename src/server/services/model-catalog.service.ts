import { createCliEnv, resolveCliBinary } from '../utils';
import {
  AGENT_DEFINITIONS,
  STATIC_AGENT_DEFINITIONS,
  type AgentDefinition,
  type ChatAgentKind,
  type ModelOption,
} from '../agents/agent-kinds';

const CACHE_TTL_MS = 10 * 60 * 1000;

let cached: { at: number; definitions: Record<ChatAgentKind, AgentDefinition> } | null = null;

function dedupeModels(primary: readonly ModelOption[], fallback: readonly ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const model of [...primary, ...fallback]) {
    if (!model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

function prioritizeCodexModels(models: readonly ModelOption[]): ModelOption[] {
  return models
    .map((model, index) => ({ model, index, rank: model.id.startsWith('gpt-5.6-') ? 0 : 1 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model);
}

function mergeDefinition(kind: ChatAgentKind, discovered: readonly ModelOption[]): AgentDefinition {
  const fallback = STATIC_AGENT_DEFINITIONS[kind];
  // fallback.models are always merged in, so fallback.defaultModel is always present.
  return { ...fallback, models: dedupeModels(discovered, fallback.models) };
}

/**
 * A successful `codex debug models` response is capability-authoritative: an
 * older CLI must not be offered newer static models that it cannot execute.
 * Static entries remain the fallback when discovery itself is unavailable.
 */
export function buildCodexDefinition(
  discovered: readonly ModelOption[],
  discoverySucceeded: boolean,
): AgentDefinition {
  const fallback = STATIC_AGENT_DEFINITIONS.codex;
  const fallbackById = new Map(fallback.models.map(model => [model.id, model]));
  const enrichedDiscovered = discovered.map(model => {
    const staticModel = fallbackById.get(model.id);
    return {
      ...model,
      label: staticModel?.label || model.label,
      description: model.description || staticModel?.description,
    };
  });
  const models = prioritizeCodexModels(
    discoverySucceeded
      ? dedupeModels(enrichedDiscovered, [])
      : dedupeModels(enrichedDiscovered, fallback.models),
  );
  const defaultModel = models.some(model => model.id === fallback.defaultModel)
    ? fallback.defaultModel
    : models[0]?.id || fallback.defaultModel;
  return { ...fallback, models, defaultModel };
}

function normalizeOpenAiName(value: unknown): string {
  return typeof value === 'string' && value ? value : '';
}

function normalizeReasoningLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value
    .map((entry: any) => normalizeOpenAiName(entry?.effort ?? entry))
    .filter(Boolean);
  return levels.length > 0 ? Array.from(new Set(levels)) : undefined;
}

async function discoverCodexModels(): Promise<{ models: ModelOption[]; succeeded: boolean }> {
  try {
    const proc = Bun.spawn([resolveCliBinary('codex'), 'debug', 'models'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: createCliEnv(),
    });
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    if (exitCode !== 0) return { models: [], succeeded: false };
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed?.models)) return { models: [], succeeded: false };
    const models = parsed.models
      .filter((m: any) => m?.visibility === 'list' && m?.supported_in_api !== false)
      .sort((a: any, b: any) => (a?.priority ?? 0) - (b?.priority ?? 0))
      .map((m: any) => ({
        id: normalizeOpenAiName(m?.slug),
        label: normalizeOpenAiName(m?.display_name) || normalizeOpenAiName(m?.slug),
        description: normalizeOpenAiName(m?.description) || undefined,
        supportedReasoningLevels: normalizeReasoningLevels(m?.supported_reasoning_levels),
        defaultReasoningLevel: normalizeOpenAiName(m?.default_reasoning_level) || undefined,
      }))
      .filter((m: ModelOption) => m.id && m.label);
    return { models, succeeded: models.length > 0 };
  } catch {
    return { models: [], succeeded: false };
  }
}

async function discoverClaudeModels(): Promise<ModelOption[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
    });
    if (!res.ok) return [];
    const parsed = await res.json();
    const models = Array.isArray(parsed?.data) ? parsed.data : [];
    return models
      .map((m: any) => ({
        id: typeof m?.id === 'string' ? m.id : '',
        label: typeof m?.display_name === 'string' ? m.display_name : '',
      }))
      .filter((m: ModelOption) => m.id.startsWith('claude-') && m.label);
  } catch {
    return [];
  }
}

export async function getModelCatalog(forceRefresh = false): Promise<Record<ChatAgentKind, AgentDefinition>> {
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.at < CACHE_TTL_MS) return cached.definitions;

  const [claudeModels, codexDiscovery] = await Promise.all([
    discoverClaudeModels(),
    discoverCodexModels(),
  ]);

  const definitions: Record<ChatAgentKind, AgentDefinition> = {
    claude: mergeDefinition('claude', claudeModels),
    codex: buildCodexDefinition(codexDiscovery.models, codexDiscovery.succeeded),
  };

  Object.assign(AGENT_DEFINITIONS, definitions);
  cached = { at: now, definitions };
  return definitions;
}
