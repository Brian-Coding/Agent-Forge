import { getAgentDefinition, type ChatAgentKind } from './agent-kinds';
import { claudeAdapter } from './adapters/claude';
import type { AgentAdapter } from './types';

/**
 * Adapter registry. Adapters register themselves via `registerAdapter()`
 * from their own module (avoids circular imports between adapter files).
 *
 * Phase 2 registers Claude. Phase 3 registers Codex.
 */
const adapters: Partial<Record<ChatAgentKind, AgentAdapter<any>>> = {
  claude: claudeAdapter,
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
