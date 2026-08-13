/**
 * Provider/model registry. Static fallback used when dynamic CLI/API model
 * discovery is unavailable.
 */

export type ChatAgentKind = 'claude' | 'codex';

export const CHAT_AGENT_KINDS: readonly ChatAgentKind[] = ['claude', 'codex'] as const;

export interface ModelOption {
  id: string;          // The exact string passed to --model
  label: string;       // What the UI dropdown shows
  description?: string; // Short model guidance shown beneath the selector
  supportedReasoningLevels?: readonly string[];
  defaultReasoningLevel?: string;
}

export interface AgentDefinition {
  kind: ChatAgentKind;
  label: string;             // "Claude" | "Codex"
  supportsResume: boolean;
  supportsReasoningLevel: boolean;
  models: readonly ModelOption[];
  defaultModel: string;
  reasoningLevels?: readonly string[];
  defaultReasoningLevel?: string;
}

export const STATIC_AGENT_DEFINITIONS: Record<ChatAgentKind, AgentDefinition> = {
  claude: {
    kind: 'claude',
    label: 'Claude',
    supportsResume: true,
    supportsReasoningLevel: false,
    models: [
      // Only real, account-accessible ids belong here. Phantom ids are dangerous:
      // the API silently downgrades some (claude-sonnet-5 → claude-sonnet-4-6) and
      // hard-errors others (claude-mythos-5). The runtime modelRan-divergence warning
      // in the claude adapter is the backstop if a listed id ever rots. When
      // ANTHROPIC_API_KEY is set, discovered models are merged in ahead of these.
      { id: 'claude-fable-5',            label: 'Fable 5' },
      { id: 'claude-opus-4-8',           label: 'Opus 4.8' },
      { id: 'claude-opus-4-7',           label: 'Opus 4.7' },
      { id: 'claude-opus-4-6',           label: 'Opus 4.6' },
      { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
    defaultModel: 'claude-opus-4-8',
  },
  codex: {
    kind: 'codex',
    label: 'Codex',
    supportsResume: true,
    supportsReasoningLevel: true,
    models: [
      // GPT-5.6 ids confirmed against the OpenAI model docs (gpt-5.6-sol /
      // gpt-5.6-terra; Luna deliberately omitted — not requested). Static
      // fallback until `codex debug models` discovery lists the 5.6 family.
      {
        id: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        description: 'Latest frontier agentic coding model.',
        supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultReasoningLevel: 'medium',
      },
      { id: 'gpt-5.6-terra',     label: 'GPT-5.6 Terra', description: 'Balanced agentic coding model for everyday work.' },
      { id: 'gpt-5.5',           label: 'GPT-5.5' },
      { id: 'gpt-5.4',           label: 'GPT-5.4' },
      { id: 'gpt-5.2-codex',     label: 'GPT-5.2 Codex' },
      { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
    ],
    defaultModel: 'gpt-5.6-sol',
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoningLevel: 'medium',
  },
};

export const AGENT_DEFINITIONS: Record<ChatAgentKind, AgentDefinition> = {
  ...STATIC_AGENT_DEFINITIONS,
};

export function getAgentDefinition(kind: ChatAgentKind): AgentDefinition {
  return AGENT_DEFINITIONS[kind];
}

export function isChatAgentKind(value: unknown): value is ChatAgentKind {
  return value === 'claude' || value === 'codex';
}

/**
 * Strip a context-tier suffix like "[1m]" from a model id so
 * "claude-opus-4-8[1m]" and "claude-opus-4-8" compare equal. Used everywhere
 * a requested model is compared against the CLI-reported ground truth, so a
 * tier difference alone never counts as a mismatch.
 */
export function stripModelTier(model: string): string {
  return model.replace(/\[[^\]]*\]$/, '');
}

/**
 * Claude Code occasionally reports bookkeeping buckets such as
 * `<synthetic>` in result.modelUsage. Those are accounting labels, not models
 * that can be selected or resumed, and must never become model ground truth.
 */
export function isRealClaudeModelId(model: unknown): model is string {
  if (typeof model !== 'string') return false;
  return /^claude-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\[[a-z0-9-]+\])?$/i.test(model);
}
