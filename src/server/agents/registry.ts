import { getAgentDefinition, type ChatAgentKind } from './agent-kinds';
import { claudeAdapter } from './adapters/claude';
import { codexAdapter } from './adapters/codex';
import type { AgentAdapter } from './types';

/**
 * Adapter registry. Both Claude and Codex are wired here. Add a new
 * provider by extending the shared provider types and model definitions,
 * implementing AgentAdapter, and registering it here.
 */
const adapters: Partial<Record<ChatAgentKind, AgentAdapter<any>>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function registerAdapter(adapter: AgentAdapter<any>): void {
  if (adapters[adapter.kind]) {
    console.warn(`[agents] Overwriting adapter for ${adapter.kind}`);
  }
  adapters[adapter.kind] = adapter;
}

export function getAgentAdapter(kind: ChatAgentKind): AgentAdapter<any> | null {
  return adapters[kind] ?? null;
}

/**
 * Resolve the model to spawn with. Falls back to the provider's default if
 * the requested model isn't in the definition's list.
 */
export function resolveAgentModel(
  agentKind: ChatAgentKind,
  requestedModel?: string,
): string | undefined {
  const definition = getAgentDefinition(agentKind);
  if (!definition.models.length) return undefined;
  if (requestedModel && definition.models.some(m => m.id === requestedModel)) {
    return requestedModel;
  }
  return definition.defaultModel || definition.models[0]?.id;
}

/** Resolve reasoning against the selected model's live CLI capabilities. */
export function resolveAgentReasoningLevel(
  agentKind: ChatAgentKind,
  modelId: string | undefined,
  requestedLevel?: string,
): string | undefined {
  const definition = getAgentDefinition(agentKind);
  if (!definition.supportsReasoningLevel) return undefined;
  const model = definition.models.find(option => option.id === modelId);
  const supported = model?.supportedReasoningLevels ?? definition.reasoningLevels ?? [];
  const normalized = requestedLevel === 'extra_high' ? 'xhigh' : requestedLevel;
  if (normalized && supported.includes(normalized)) return normalized;
  const preferredDefault = model?.defaultReasoningLevel ?? definition.defaultReasoningLevel;
  if (preferredDefault && supported.includes(preferredDefault)) return preferredDefault;
  return supported[0];
}
