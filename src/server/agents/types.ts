import type { ChatAgentKind } from './agent-kinds';
import type { AgentEvent } from './events';

export interface AgentActivityEvent {
  toolName: string;
  summary: string;
  isStreaming?: boolean;
}

/**
 * Per-run context handed to an adapter. Adapters never broadcast directly;
 * they emit via these callbacks, and the ChatService bridge translates the
 * normalized events back into the existing wire protocol.
 */
export interface AgentRunContext {
  readonly paneId: string;            // The agent ID (kept "paneId" for symmetry with the reference design)
  readonly cwd: string;
  readonly referencePaths?: readonly string[];
  readonly systemPrompt?: string;     // Already-built appended system prompt (provider-agnostic)
  readonly model?: string;
  readonly reasoningLevel?: string;   // Codex-only
  getSessionId(): string | null;
  updateSessionId(nextSessionId: string): void;
  emitChatEvent(event: unknown): void;        // Raw provider event (for buffers / debugging)
  emitAgentEvent(event: AgentEvent): void;    // Normalized event (the bridge listens to these)
  emitStatus(status: string, isLoading?: boolean): void;
  emitActivity(activity: AgentActivityEvent): void;
  emitSystemMessage(message: string): void;
}

export interface AgentHandle {
  run(): Promise<AgentRunResult | undefined>;
  stop(): void;
  kill(): void;
}

export interface AgentRunResult {
  lastAssistantMessage?: string;
}

export interface AgentAdapter<State = unknown> {
  readonly kind: ChatAgentKind;
  readonly displayName: string;
  createState(ctx: AgentRunContext): State;
  createHandle(prompt: string, ctx: AgentRunContext, state: State): AgentHandle;
}
