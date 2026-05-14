import { getAgentDefinition, type ChatAgentKind } from './agent-kinds';
import { claudeAdapter } from './adapters/claude';
import { codexAdapter } from './adapters/codex';
import type { AgentAdapter } from './types';

/**
 * Adapter registry. Both Claude and Codex are wired here. Add a new
 * provider by implementing the AgentAdapter contract and adding it to
 * the map below — no other code changes required.
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

export function hasAgentAdapter(kind: ChatAgentKind): boolean {
  return adapters[kind] != null;
}

export function listRegisteredKinds(): ChatAgentKind[] {
  return Object.keys(adapters) as ChatAgentKind[];
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
