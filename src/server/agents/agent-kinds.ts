/**
 * Provider/model registry. Adding a new model = one line here.
 * The UI's inline dropdowns read directly from `MODELS[provider]`.
 */

export type ChatAgentKind = 'claude' | 'codex';

export const CHAT_AGENT_KINDS: readonly ChatAgentKind[] = ['claude', 'codex'] as const;

export interface ModelOption {
  id: string;          // The exact string passed to --model
  label: string;       // What the UI dropdown shows
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

const CLAUDE_DEFINITION: AgentDefinition = {
  kind: 'claude',
  label: 'Claude',
  supportsResume: true,
  supportsReasoningLevel: false,
  models: [
    { id: 'claude-opus-4-7',         label: 'Opus 4.7' },
    { id: 'claude-opus-4-6',         label: 'Opus 4.6' },
    { id: 'claude-sonnet-4-6',       label: 'Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ],
  defaultModel: 'claude-opus-4-7',
};

const CODEX_DEFINITION: AgentDefinition = {
  kind: 'codex',
  label: 'Codex',
  supportsResume: true,
  supportsReasoningLevel: true,
  models: [
    { id: 'gpt-5.5',           label: 'GPT-5.5' },
    { id: 'gpt-5.4',           label: 'GPT-5.4' },
    { id: 'gpt-5.2-codex',     label: 'GPT-5.2 Codex' },
    { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
  ],
  defaultModel: 'gpt-5.5',
  reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
  defaultReasoningLevel: 'medium',
};

export const AGENT_DEFINITIONS: Record<ChatAgentKind, AgentDefinition> = {
  claude: CLAUDE_DEFINITION,
  codex: CODEX_DEFINITION,
};

export function getAgentDefinition(kind: ChatAgentKind): AgentDefinition {
  return AGENT_DEFINITIONS[kind];
}

export function isChatAgentKind(value: unknown): value is ChatAgentKind {
  return value === 'claude' || value === 'codex';
}
