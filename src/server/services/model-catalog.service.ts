import { createCliEnv, killProcessTree, resolveCliBinary } from '../utils';
import { collectBoundedProcess } from './bounded-subprocess';
import { fetchWithTimeout } from './external-io';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_DEFINITIONS,
  STATIC_AGENT_DEFINITIONS,
  isRealClaudeModelId,
  stripModelTier,
  type AgentDefinition,
  type ChatAgentKind,
  type ModelOption,
} from '../agents/agent-kinds';

const CACHE_TTL_MS = 10 * 60 * 1000;
// The disposable demo substitutes this service before the server starts.
export const modelCatalogService = { get: getModelCatalog };
export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_DISCOVERED_MODELS = 512;

let cached: { at: number; definitions: Record<ChatAgentKind, AgentDefinition> } | null = null;
let refreshPromise: Promise<Record<ChatAgentKind, AgentDefinition>> | null = null;

interface CodexModelDiscovery {
  models: ModelOption[];
  succeeded: boolean;
}

const observedModels: Record<ChatAgentKind, Set<string>> = (globalThis as any).__observedProviderModels ??= {
  claude: new Set<string>(),
  codex: new Set<string>(),
};

function observedModelOptions(kind: ChatAgentKind): ModelOption[] {
  return Array.from(observedModels[kind]).map(id => ({
    id,
    label: id
      .replace(/^claude-/, '')
      .replace(/-\d{8}$/, '')
      .replace(/(\d+)-(\d+)(?=-|$)/g, '$1.$2')
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    description: 'Observed from this provider at runtime.',
  }));
}

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

export function buildClaudeDefinition(discovered: readonly ModelOption[]): AgentDefinition {
  const fallback = STATIC_AGENT_DEFINITIONS.claude;
  // fallback.models are always merged in, so fallback.defaultModel is always present.
  return {
    ...fallback,
    models: dedupeModels(dedupeModels(discovered, fallback.models), observedModelOptions('claude')),
  };
}

/** Learn real provider model ids reported by the CLI, even for OAuth-backed
 * Claude installations where the public model-list API is unavailable. */
export function observeProviderModel(kind: ChatAgentKind, rawModel: string): boolean {
  // Codex discovery already determines visibility and ordering. Observing a
  // run must not promote a lower-priority entry or expose an internal model.
  if (kind === 'codex') return false;
  const model = stripModelTier(rawModel);
  if (!isRealClaudeModelId(model)) return false;
  const current = AGENT_DEFINITIONS[kind];
  if (current.models.some(option => option.id === model)) return false;
  if (observedModels[kind].has(model)) return false;
  observedModels[kind].add(model);

  const updated = { ...current, models: dedupeModels(current.models, observedModelOptions(kind)) };
  AGENT_DEFINITIONS[kind] = updated;
  if (cached) {
    cached.definitions = { ...cached.definitions, [kind]: updated };
  }
  return true;
}

/**
 * A successful `codex debug models` response is capability-authoritative: an
 * older CLI must not be offered newer static models that it cannot execute.
 * Static entries remain the fallback when discovery itself is unavailable.
 */
export function buildCodexDefinition(
  discovered: readonly ModelOption[],
  discoverySucceeded: boolean,
  configuredModel?: string,
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
  const models =
    discoverySucceeded
      ? dedupeModels(enrichedDiscovered, [])
      : dedupeModels(enrichedDiscovered, fallback.models);
  const preferredModel = configuredModel || (discoverySucceeded ? models[0]?.id : fallback.defaultModel);
  const defaultModel = models.find(model => model.id === preferredModel)?.id
    || models[0]?.id || fallback.defaultModel;
  return { ...fallback, models, defaultModel };
}

/** Only the top-level model preference is consumed; no credentials or other
 * configuration values are returned or logged. Missing/invalid config is optional. */
export async function readConfiguredCodexModel(
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
): Promise<string | undefined> {
  try {
    const { model } = Bun.TOML.parse(await Bun.file(join(codexHome, 'config.toml')).text()) as { model?: unknown };
    return typeof model === 'string' && model.trim() ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOpenAiName(value: unknown, maxChars = 500): string {
  return typeof value === 'string' && value ? value.slice(0, maxChars) : '';
}

function normalizeReasoningLevels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = value
    .slice(0, 32)
    .map((entry: any) => normalizeOpenAiName(entry?.effort ?? entry, 64))
    .filter(Boolean);
  return levels.length > 0 ? Array.from(new Set(levels)) : undefined;
}

export function parseCodexModelDiscovery(parsed: unknown): ModelOption[] {
  if (!Array.isArray((parsed as any)?.models)) return [];
  return (parsed as any).models
    .slice(0, MAX_DISCOVERED_MODELS)
    .filter((m: any) => m?.visibility === 'list' && m?.supported_in_api !== false)
    .sort((a: any, b: any) => (Number.isFinite(a?.priority) ? a.priority : 0) - (Number.isFinite(b?.priority) ? b.priority : 0))
    .map((m: any) => ({
      id: normalizeOpenAiName(m?.slug, 200),
      label: normalizeOpenAiName(m?.display_name, 200) || normalizeOpenAiName(m?.slug, 200),
      description: normalizeOpenAiName(m?.description, 2_000) || undefined,
      supportedReasoningLevels: normalizeReasoningLevels(m?.supported_reasoning_levels),
      defaultReasoningLevel: normalizeOpenAiName(m?.default_reasoning_level, 64) || undefined,
    }))
    .filter((m: ModelOption) => m.id && m.label);
}

export function parseClaudeModelDiscovery(parsed: unknown): ModelOption[] {
  const models = Array.isArray((parsed as any)?.data) ? (parsed as any).data : [];
  return models
    .slice(0, MAX_DISCOVERED_MODELS)
    .map((m: any) => ({
      id: normalizeOpenAiName(m?.id, 200),
      label: normalizeOpenAiName(m?.display_name, 200),
    }))
    .filter((m: ModelOption) => m.id.startsWith('claude-') && !!m.label);
}

async function discoverCodexModelsOnce(): Promise<CodexModelDiscovery> {
  try {
    const proc = Bun.spawn([resolveCliBinary('codex'), 'debug', 'models'], { detached: process.platform !== 'win32',
      stdout: 'pipe',
      stderr: 'pipe',
      env: createCliEnv(),
    });
    const result = await collectBoundedProcess(proc, {
      timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
      terminationTimeoutMs: 3_000,
      maxChars: 2_000_000,
      label: 'Codex model discovery',
      terminate: () => killProcessTree(proc),
    });
    if (result.timedOut || result.error || result.exitCode !== 0) return { models: [], succeeded: false };
    const models = parseCodexModelDiscovery(JSON.parse(result.stdout));
    return { models, succeeded: models.length > 0 };
  } catch {
    return { models: [], succeeded: false };
  }
}

/**
 * `codex debug models` can return the pre-refresh disk catalog on its first
 * invocation after boot while refreshing that cache for the next invocation.
 * That made Forge accept the old response as authoritative for the whole UI
 * session and silently replace a persisted Astra selection with Sol.
 *
 * Retry once when the otherwise-valid result omits Forge's preferred static
 * Codex model. The second successful result remains capability-authoritative,
 * so an older CLI or an account without access still does not get unsupported
 * static entries appended to its catalog.
 */
export async function stabilizeCodexModelDiscovery(
  first: CodexModelDiscovery,
  retry: () => Promise<CodexModelDiscovery>,
): Promise<CodexModelDiscovery> {
  const preferredModel = STATIC_AGENT_DEFINITIONS.codex.models[0]?.id;
  const needsRetry = first.succeeded
    && !!preferredModel
    && !first.models.some(model => model.id === preferredModel);
  if (!needsRetry) return first;

  const second = await retry();
  return second.succeeded ? second : first;
}

async function discoverCodexModels(): Promise<CodexModelDiscovery> {
  const first = await discoverCodexModelsOnce();
  return stabilizeCodexModelDiscovery(first, discoverCodexModelsOnce);
}

async function discoverClaudeModels(): Promise<ModelOption[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/models', {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': apiKey,
      },
    }, MODEL_DISCOVERY_TIMEOUT_MS, 'Claude model discovery');
    if (!res.ok) return [];
    const parsed = await res.json();
    return parseClaudeModelDiscovery(parsed);
  } catch {
    return [];
  }
}

export async function getModelCatalog(forceRefresh = false): Promise<Record<ChatAgentKind, AgentDefinition>> {
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.at < CACHE_TTL_MS) return cached.definitions;
  if (refreshPromise) return refreshPromise;

  const refresh = (async () => {
    const [claudeModels, codexDiscovery, configuredCodexModel] = await Promise.all([
      discoverClaudeModels(),
      discoverCodexModels(),
      readConfiguredCodexModel(),
    ]);

    const definitions: Record<ChatAgentKind, AgentDefinition> = {
      claude: buildClaudeDefinition(claudeModels),
      codex: buildCodexDefinition(codexDiscovery.models, codexDiscovery.succeeded, configuredCodexModel),
    };

    Object.assign(AGENT_DEFINITIONS, definitions);
    cached = { at: Date.now(), definitions };
    return definitions;
  })();
  refreshPromise = refresh;
  try {
    return await refresh;
  } finally {
    if (refreshPromise === refresh) refreshPromise = null;
  }
}
