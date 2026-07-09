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

function mergeDefinition(kind: ChatAgentKind, discovered: readonly ModelOption[]): AgentDefinition {
  const fallback = STATIC_AGENT_DEFINITIONS[kind];
  // fallback.models are always merged in, so fallback.defaultModel is always present.
  return { ...fallback, models: dedupeModels(discovered, fallback.models) };
}

function normalizeOpenAiName(value: unknown): string {
  return typeof value === 'string' && value ? value : '';
}

async function discoverCodexModels(): Promise<ModelOption[]> {
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
    if (exitCode !== 0) return [];
    const parsed = JSON.parse(stdout);
    const models = Array.isArray(parsed?.models) ? parsed.models : [];
    return models
      .filter((m: any) => m?.visibility === 'list' && m?.supported_in_api !== false)
      .sort((a: any, b: any) => (a?.priority ?? 0) - (b?.priority ?? 0))
      .map((m: any) => ({
        id: normalizeOpenAiName(m?.slug),
        label: normalizeOpenAiName(m?.display_name) || normalizeOpenAiName(m?.slug),
      }))
      .filter((m: ModelOption) => m.id && m.label);
  } catch {
    return [];
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

  const [claudeModels, codexModels] = await Promise.all([
    discoverClaudeModels(),
    discoverCodexModels(),
  ]);

  const definitions: Record<ChatAgentKind, AgentDefinition> = {
    claude: mergeDefinition('claude', claudeModels),
    codex: mergeDefinition('codex', codexModels),
  };

  Object.assign(AGENT_DEFINITIONS, definitions);
  cached = { at: now, definitions };
  return definitions;
}
