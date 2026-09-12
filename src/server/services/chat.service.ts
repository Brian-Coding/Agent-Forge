import type { AgentEvent } from '../agents/events';
import type { AgentHandle, AgentRunContext } from '../agents/types';
import type { ChatImageAttachment } from '../../shared/protocol';
import { isRealClaudeModelId, stripModelTier, type ChatAgentKind } from '../agents/agent-kinds';
import { getAgentAdapter, resolveAgentModel, resolveAgentReasoningLevel } from '../agents/registry';
import { broadcast } from '../broadcast';
import { agentService } from './agent.service';
import { documentService } from './document.service';
import { persistenceService } from './persistence.service';
import { promptBuilderService } from './prompt-builder.service';
import { usageService } from './usage.service';
import { liveTurnStateService } from './live-turn-state.service';
import { observeProviderModel } from './model-catalog.service';
import { compactThinkingText, sanitizeCliText } from '../agents/stream-utils';
import {
  createInactivityWatchdog,
  observeTurnOutputEvent,
  parseOptionalInactivityTimeout,
  resolveTurnFinalization,
  resolveTurnOutcome,
  type InactivityWatchdog,
  type TurnAbortReason,
} from './chat-turn-lifecycle';
import { authRecoveryStore } from '../auth/auth-recovery';
import { shouldAutomaticallyRetryExpiredAuth } from '../auth/auth-retry-policy';
import { currentAuthCoordinator } from '../auth/provider-auth-coordinator';

// --- HMR-safe state ---------------------------------------------------------

// Per-agent FIFO of in-flight + queued turns. Each new send chains onto the
// prior one's promise so calls to the same agent serialize cleanly.
const sendLocks: Map<string, Promise<void>> = (globalThis as any).__chatSendLocks ??= new Map();

// Per-agent in-flight adapter handle. Populated when an adapter is running,
// cleared when its run() resolves. stop() / kill() route through here.
const currentHandles: Map<string, AgentHandle> = (globalThis as any).__chatCurrentHandles ??= new Map();

// Per-agent process buffer. Traditional providers flush once at process exit;
// long-lived goal providers may also persist completed turn checkpoints while
// retaining the same buffer until the underlying CLI process exits.
interface TurnBuffer {
  liveTurnId: string;
  accumulatedText: string;
  lastResultEmitted: string | null;
  lastAssistantSnapshot: string | null;
  lastPersistedResult: string | null;
  lastErrorMessage: string | null;
  persistedSystemMessages: Set<string>;
  provider: ChatAgentKind;
  resolvedModel?: string;
  abortReason?: TurnAbortReason;
  // Per-turn usage accumulator. Each adapter `usage` event sums its deltas
  // here; at turn-finalize the rolled-up totals get one entry in the usage
  // log via usageService.record() — so the log grows at most one row per
  // turn, not one row per internal API sub-call.
  turnUsage: { inputTokens: number; outputTokens: number; costUsd: number; turns: number };
  modelRan?: string;
  /** Automatic stale-session retries are unsafe after any tool/checkpoint. */
  retrySafe: boolean;
  userMessageId: string;
  authBlocked: boolean;
}

export interface ChatTurnOptions {
  imagePaths?: readonly string[];
  imageAttachments?: readonly ChatImageAttachment[];
  displayContent?: string;
}
const turnBuffers: Map<string, TurnBuffer> = (globalThis as any).__chatTurnBuffers ??= new Map();

// Per-agent epoch counter. Bumped by resetLock() (stop/kill/remove) so sends
// queued behind a cancelled turn detect the bump when they finally dequeue
// and no-op instead of firing a turn the user already abandoned. Replaces the
// old "delete the lock chain" approach, which didn't actually cancel queued
// continuations AND let a brand-new send run concurrently with the old
// turn's teardown (clobbering turnBuffers/currentHandles).
const turnEpochs: Map<string, number> = (globalThis as any).__chatTurnEpochs ??= new Map();
const liveStateLastBroadcastAt: Map<string, number> = (globalThis as any).__liveStateLastBroadcastAt ??= new Map();

// Long-running work (especially Codex /goal automatic continuation) has no
// output-silence deadline by default. Operators can explicitly opt into one
// for unattended environments; manual Stop/Kill remains available regardless.
const TURN_INACTIVITY_TIMEOUT_MS = parseOptionalInactivityTimeout(
  process.env.AGENT_TURN_INACTIVITY_MS,
);

// --- Cross-provider history prepend ---------------------------------------
// When the user swaps provider mid-conversation, the new provider has no
// session yet, so we feed it the prior UI chat history as a delimited
// context block. Sliding window + per-message + total caps keep the
// injected block small enough not to dominate the model's context.
//
// This only runs on swap boundaries. Once the new provider's first turn
// completes, ctx.updateSessionId claims the session for it, and subsequent
// same-provider turns --resume the cached session for free.

const HISTORY_RECENT_TURNS = 20;
const HISTORY_USER_CAP = 1500;
const HISTORY_ASSISTANT_CAP = 1500;
const HISTORY_MAX_TOTAL = 12000;
export const MAX_PERSISTED_CHAT_CHARS = 512_000;
const MAX_OUTPUT_FRAME_CHARS = 64_000;

function boundedChatText(text: string, maxChars = MAX_PERSISTED_CHAT_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = '\n\n[Output truncated by Agent Forge]';
  return text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}

function appendBoundedChatText(current: string, delta: string): string {
  if (!delta || current.length >= MAX_PERSISTED_CHAT_CHARS) return current;
  const remaining = MAX_PERSISTED_CHAT_CHARS - current.length;
  if (delta.length <= remaining) return current + delta;
  const marker = '\n\n[Output truncated by Agent Forge]';
  return current + delta.slice(0, Math.max(0, remaining - marker.length)) + marker;
}

function broadcastOutputFrames(agentId: string, content: string): void {
  for (let offset = 0; offset < content.length; offset += MAX_OUTPUT_FRAME_CHARS) {
    broadcast({
      type: 'output',
      agentId,
      content: content.slice(offset, offset + MAX_OUTPUT_FRAME_CHARS),
      stream: 'stdout',
    });
  }
}

function prependPriorHistory(agentId: string, currentUserContent: string): string {
  const all = agentService.getMessages(agentId);
  // Exclude the user message we just appended (the prompt is already going
  // in as the actual turn) plus any pure-system bookkeeping rows.
  const turns = all
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(0, -1) // drop the just-appended user message
    .slice(-HISTORY_RECENT_TURNS);

  if (turns.length === 0) return currentUserContent;

  const formatted = turns.map(m => {
    const cap = m.role === 'user' ? HISTORY_USER_CAP : HISTORY_ASSISTANT_CAP;
    const label = m.role === 'user'
      ? 'User'
      : `Assistant (${m.provider === 'codex' ? 'Codex' : 'Claude'})`;
    const text = m.content.length > cap
      ? m.content.substring(0, cap) + `... [truncated, ${m.content.length - cap} chars cut]`
      : m.content;
    return `[${label}]: ${text}`;
  });

  // Total-budget walk: drop oldest until under HISTORY_MAX_TOTAL.
  let totalLen = formatted.reduce((s, t) => s + t.length + 2, 0);
  let dropped = 0;
  while (totalLen > HISTORY_MAX_TOTAL && formatted.length > 1) {
    const out = formatted.shift()!;
    totalLen -= out.length + 2;
    dropped++;
  }

  const header = [
    '=== Prior conversation (from earlier turns with this agent, possibly with a different LLM provider) ===',
    'You are continuing a chat that may have included turns from a different model. Treat the messages below as established conversation context: the user said what is shown, and the assistant replies shown are what the user already saw. Don\'t re-introduce yourself or restart the conversation unless the user explicitly asks.',
    dropped > 0 ? `(${dropped} earlier message${dropped === 1 ? '' : 's'} omitted to keep this block compact)` : null,
  ].filter(Boolean).join('\n');

  return [
    header,
    '',
    formatted.join('\n\n'),
    '',
    '=== Current user message ===',
    currentUserContent,
  ].join('\n');
}

// --- Bridge: translate normalized AgentEvent → wire-protocol messages -------

/**
 * Make a raw CLI stderr chunk safe for any future diagnostic UI surface.
 * Strips ANSI escapes, then drops the chunk entirely when it is mostly
 * non-printable (a binary dump — e.g. a crashing CLI spilling a panic
 * backtrace or core-fragment bytes, which decode to U+FFFD replacement
 * characters). Otherwise removes any stray control bytes and returns the
 * readable remainder. Empty string means "nothing worth showing".
 */
export function sanitizeStderrForChat(text: string): string {
  return sanitizeCliText(text);
}

function persistAssistantResult(
  agentId: string,
  text: string,
  turn: TurnBuffer,
  allowRepeatedCheckpoint = false,
): boolean {
  const content = boundedChatText(text.trim());
  if (!content || (!allowRepeatedCheckpoint && content === turn.lastPersistedResult)) return false;

  const assistantMsg = agentService.appendMessage(
    agentId,
    'assistant',
    content,
    undefined,
    undefined,
    undefined,
    turn.provider,
    turn.modelRan || turn.resolvedModel,
  );
  turn.lastPersistedResult = content;
  turn.lastAssistantSnapshot = null;
  broadcast({ type: 'message', message: assistantMsg });
  return true;
}

function broadcastLiveTurnState(agentId: string, force = false): void {
  const state = liveTurnStateService.get(agentId);
  if (!state) return;
  const now = Date.now();
  const last = liveStateLastBroadcastAt.get(agentId) ?? 0;
  if (!force && now - last < 2_000) return;
  liveStateLastBroadcastAt.set(agentId, now);
  broadcast({ type: 'live_turn_state', state });
}

function handleEvent(agentId: string, event: AgentEvent): void {
  const activeTurn = turnBuffers.get(agentId);
  if (activeTurn) liveTurnStateService.touch(agentId, activeTurn.liveTurnId);

  switch (event.type) {
    case 'provider-turn': {
      if (activeTurn) {
        const next = liveTurnStateService.observeProviderTurn(agentId, activeTurn.liveTurnId, event.state);
        if (next) broadcastLiveTurnState(agentId, true);
      }
      return;
    }
    case 'text-delta': {
      const turn = activeTurn;
      if (turn) turn.accumulatedText = appendBoundedChatText(turn.accumulatedText, event.text);
      if (turn) liveTurnStateService.appendResponse(agentId, turn.liveTurnId, event.text);
      broadcastOutputFrames(agentId, event.text);
      return;
    }

    case 'thinking-delta': {
      const compact = event.streaming ? event.text : compactThinkingText(event.text);
      if (compact) {
        const content = event.streaming ? compact : compact + '\n';
        if (activeTurn) liveTurnStateService.appendThought(agentId, activeTurn.liveTurnId, content);
        broadcast({ type: 'thinking_output', agentId, content });
      }
      return;
    }

    case 'assistant-snapshot': {
      const turn = turnBuffers.get(agentId);
      if (turn) observeTurnOutputEvent(turn, { ...event, text: boundedChatText(event.text) });
      return;
    }

    case 'stderr': {
      if (/No conversation found with session ID/i.test(event.text)) return;
      // CLI stderr is diagnostics, not agent output. Keep it server-side;
      // adapters emit a clean error event on non-zero exit, so real failures
      // still surface without ANSI traces or binary fragments flooding chat.
      return;
    }

    case 'tool-call-start': {
      // Sniff Write/Edit on .plans/*.md and forward to documentService for the
      // live-document sync. Other tool calls stay hidden to keep chat readable.
      sniffPlanWrite(agentId, event.toolName, event.input);
      const label = event.summary ? `${event.toolName}: ${event.summary}` : `Using ${event.toolName}`;
      const timestamp = Date.now();
      if (activeTurn) {
        activeTurn.retrySafe = false;
        liveTurnStateService.setActivity(agentId, activeTurn.liveTurnId, { label, timestamp, kind: 'tool' });
      }
      broadcast({ type: 'agent_activity', agentId, label, timestamp, kind: 'tool' });
      broadcastLiveTurnState(agentId, true);
      return;
    }

    case 'tool-call-end': {
      // Tool results are surfaced by the next assistant turn's narrative; no
      // separate wire event needed.
      if (activeTurn) {
        liveTurnStateService.clearActivity(agentId, activeTurn.liveTurnId, 'tool');
        liveTurnStateService.toolCompleted(agentId, activeTurn.liveTurnId);
      }
      broadcast({ type: 'agent_activity', agentId, label: '', timestamp: Date.now(), kind: 'tool', clear: true });
      broadcastLiveTurnState(agentId, true);
      return;
    }

    case 'usage': {
      agentService.applyUsage(agentId, {
        contextTokens: event.contextTokens,
        contextLimit: event.contextLimit,
        inputTokensDelta: event.inputTokensDelta,
        outputTokensDelta: event.outputTokensDelta,
        costUsdDelta: event.costUsdDelta,
        turnsDelta: event.turnsDelta,
        modelRan: event.modelRan,
      });
      // Accumulate into the per-turn buffer for the usage-log record at finalize.
      const turn = turnBuffers.get(agentId);
      if (turn) {
        const finitePositive = (value: unknown): value is number =>
          typeof value === 'number' && Number.isFinite(value) && value > 0;
        if (finitePositive(event.inputTokensDelta)) turn.turnUsage.inputTokens += event.inputTokensDelta;
        if (finitePositive(event.outputTokensDelta)) turn.turnUsage.outputTokens += event.outputTokensDelta;
        if (finitePositive(event.costUsdDelta)) turn.turnUsage.costUsd += event.costUsdDelta;
        if (finitePositive(event.turnsDelta)) turn.turnUsage.turns += event.turnsDelta;
        if (typeof event.modelRan === 'string' && event.modelRan) {
          turn.modelRan = event.modelRan;
          observeProviderModel(turn.provider, event.modelRan);
        }
      }
      const snap = agentService.getTokenUsage(agentId);
      if (snap) {
        broadcast({
          type: 'token_usage',
          agentId,
          contextTokens: snap.contextTokens,
          contextLimit: snap.contextLimit,
          totalInputTokens: snap.totalInputTokens,
          totalOutputTokens: snap.totalOutputTokens,
          totalCostUsd: snap.totalCostUsd,
          numTurns: snap.numTurns,
          modelRan: snap.lastModelRan,
        });
      }
      return;
    }

    case 'session': {
      // Already persisted by the adapter via ctx.updateSessionId. Nothing more here.
      return;
    }

    case 'status': {
      const wire = event.status === 'thinking'
        ? 'thinking'
        : event.status === 'error'
          ? 'error'
          : event.status === 'idle'
            ? 'idle'
            : 'working';
      agentService.setStatus(agentId, wire as any);
      if (activeTurn) {
        const phase = event.status === 'thinking'
          ? 'thinking'
          : event.status === 'responding'
            ? 'responding'
            : event.status === 'tool'
              ? 'tool'
              : event.status === 'idle'
                ? 'idle'
                : 'working';
        const current = liveTurnStateService.get(agentId);
        if (current?.phase !== phase) {
          liveTurnStateService.setPhase(agentId, activeTurn.liveTurnId, phase);
          broadcastLiveTurnState(agentId, true);
        } else {
          broadcastLiveTurnState(agentId);
        }
      }
      return;
    }

    case 'result': {
      // Process-level results remain finalization fallbacks. Provider turn
      // checkpoints are persisted immediately because a /goal process can
      // continue working for hours after one completed assistant response.
      const turn = turnBuffers.get(agentId);
      if (turn) {
        const observation = observeTurnOutputEvent(turn, { ...event, text: boundedChatText(event.text) });
        if (observation.checkpointText) {
          turn.retrySafe = false;
          persistAssistantResult(agentId, observation.checkpointText, turn, true);
        }
      }
      return;
    }

    case 'transport-status': {
      const agentName = agentService.getAgent(agentId)?.name ?? 'unknown';
      if (event.status === 'recovered') {
        console.info(`[chat] Codex transport recovered agent=${agentId} name=${JSON.stringify(agentName)}`);
        broadcast({
          type: 'agent_activity',
          agentId,
          label: '',
          timestamp: Date.now(),
          kind: 'transport',
          clear: true,
        });
        if (activeTurn) liveTurnStateService.clearActivity(agentId, activeTurn.liveTurnId, 'transport');
        broadcastLiveTurnState(agentId, true);
        return;
      }

      const attemptLabel = event.attempt && event.maxAttempts
        ? ` ${event.attempt}/${event.maxAttempts}`
        : '';
      const label = event.status === 'fallback'
        ? 'Codex switching to HTTPS transport…'
        : `Codex reconnecting…${attemptLabel}`;
      console.warn(
        `[chat] ${label} agent=${agentId} name=${JSON.stringify(agentName)}: ${event.message ?? 'transport interrupted'}`,
      );
      const timestamp = Date.now();
      broadcast({
        type: 'agent_activity',
        agentId,
        label,
        timestamp,
        kind: 'transport',
        detail: event.message,
      });
      if (activeTurn) {
        liveTurnStateService.setActivity(agentId, activeTurn.liveTurnId, {
          label,
          timestamp,
          kind: 'transport',
          detail: event.message,
        });
      }
      broadcastLiveTurnState(agentId, true);
      return;
    }

    case 'error': {
      const turn = turnBuffers.get(agentId);
      const message = boundedChatText(event.message);
      if (turn) observeTurnOutputEvent(turn, { ...event, message });
      broadcast({ type: 'error', message, agentId });
      return;
    }

    case 'finish': {
      if (event.reason === 'auth-error' && activeTurn) activeTurn.authBlocked = true;
      return;
    }

    case 'raw': {
      // Provider passthrough — currently no UI surface.
      return;
    }
  }
}

// --- Plan-write sniff -------------------------------------------------------

function sniffPlanWrite(agentId: string, toolName: string, input: unknown): void {
  if (toolName !== 'Write' && toolName !== 'Edit') return;
  if (!input || typeof input !== 'object') return;
  const payload = input as Record<string, unknown>;
  const filePathRaw = payload.file_path ?? payload.path;
  if (typeof filePathRaw !== 'string' || !filePathRaw) return;
  if (!filePathRaw.includes('.plans/') && !filePathRaw.includes('.plans\\')) return;

  // For Write we have the full content directly. For Edit we only have the
  // delta strings (old_string / new_string) — the documentService.startPlansWatcher
  // fs.watch will pick up the disk change shortly and call syncPlanFromFile,
  // so we don't need to reconstruct the edited content here.
  const content = payload.content;
  if (typeof content !== 'string') return;

  const info = agentService.getAgent(agentId);
  if (!info) return;
  const isRunning = info.status === 'working' || info.status === 'thinking';
  documentService.handlePlanWrite(agentId, info.name, isRunning, info.workspaceId, filePathRaw, content)
    .catch(e => console.error('[chat] handlePlanWrite failed:', e));
}

// --- Run one turn -----------------------------------------------------------

async function runChatTurn(agentId: string, content: string, source?: 'qa', options: ChatTurnOptions = {}): Promise<void> {
  const info = agentService.getAgent(agentId);
  if (!info) {
    console.warn(`[chat] sendMessage: agent not found ${agentId}`);
    return;
  }
  const turnEpochAtStart = turnEpochs.get(agentId) ?? 0;

  // 0) Model-mismatch hard stop. A prior turn was served by a different model
  // than the user selected; refuse to run more turns until they resolve it via
  // the banner. The message is NOT appended to history so nothing is silently
  // swallowed — the user resends after resolving.
  if (info.modelMismatch) {
    const mm = info.modelMismatch;
    const sysMsg = agentService.addSystemMessage(
      agentId,
      `🛑 Message not sent. The last turn was served by "${mm.ran}" although "${mm.requested}" was selected. ` +
      `Use the banner above the input to either continue on ${mm.ran} (keeps this conversation) or start a ` +
      `fresh session on ${mm.requested} — then resend your message.`,
    );
    broadcast({ type: 'message', message: sysMsg });
    return;
  }

  // 1) Append user turn to history + broadcast.
  const userMsg = agentService.appendMessage(
    agentId,
    'user',
    options.displayContent ?? content,
    undefined,
    undefined,
    source,
    undefined,
    undefined,
    options.imageAttachments,
  );
  broadcast({ type: 'message', message: userMsg });

  // 2) Status: working. Adapter status events will refine to thinking/responding.
  agentService.beginTurn(agentId);

  // 3) Resolve provider + adapter.
  const provider: ChatAgentKind = (info.provider as ChatAgentKind | undefined) ?? 'claude';
  const adapter = getAgentAdapter(provider);
  if (!adapter) {
    const sysMsg = agentService.addSystemMessage(
      agentId,
      `No adapter registered for provider '${provider}'. Phase 2 wires Claude; Phase 3 adds Codex.`,
    );
    broadcast({ type: 'message', message: sysMsg });
    agentService.finishTurn(agentId, {
      status: 'failed',
      at: Date.now(),
      detail: `No adapter registered for provider '${provider}'`,
    });
    await persistenceService.saveNow();
    await agentService.notifyIdle(agentId);
    return;
  }

  // 4) Build the appended system prompt + resolve which reference paths exist.
  const { appendedSystemPrompt, validReferencePaths } = promptBuilderService.build(
    info,
    agentService.getSharedContext(),
  );

  const requestedResolvedModel = resolveAgentModel(provider, info.model);
  const resolvedReasoningLevel = resolveAgentReasoningLevel(provider, requestedResolvedModel, info.reasoningLevel);

  // 5) Decide --resume vs fresh start. We --resume only when the agent's
  //    current session is owned by THIS provider/model pair; if the user just
  //    swapped either, we start fresh and prepend the prior UI chat history so
  //    the new session has cross-boundary context. After this turn finishes,
  //    setCurrentSession claims the session for the now-current provider/model.
  const previousSessionProvider = agentService.getCurrentSessionProvider(agentId);
  const previousSessionModel = agentService.getCurrentSessionModel(agentId);
  const previousSessionId = agentService.getCurrentSessionId(agentId);
  const isProviderMatch = previousSessionProvider === provider && previousSessionModel === (requestedResolvedModel || null) && !!previousSessionId;
  let sessionIdForAdapter = isProviderMatch ? previousSessionId : null;

  // Build the prompt body. On a swap, prepend the prior conversation as
  // delimited context so the new provider sees what the previous provider
  // saw. We re-fetch messages here so it includes the user turn we just
  // appended (which is correct — the model sees its own user prompt as
  // "User: ..." within the history block, mirroring the live conversation).
  let promptBody = isProviderMatch
    ? content
    : prependPriorHistory(agentId, content);

  // 6) Build AgentRunContext — closures over agentId so emit callbacks route.
  const turn: TurnBuffer = {
    liveTurnId: liveTurnStateService.begin(agentId, provider).turnId,
    accumulatedText: '',
    lastResultEmitted: null,
    lastAssistantSnapshot: null,
    lastPersistedResult: null,
    lastErrorMessage: null,
    persistedSystemMessages: new Set(),
    provider,
    resolvedModel: requestedResolvedModel,
    turnUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 },
    retrySafe: true,
    userMessageId: userMsg.id,
    authBlocked: false,
  };
  turnBuffers.set(agentId, turn);
  broadcastLiveTurnState(agentId, true);

  // Watchdog activity clock — any adapter event counts as liveness.
  let activeWatchdog: InactivityWatchdog | null = null;
  let activeAttemptId = 0;
  let acceptingEvents = true;

  // Never swap a requested model silently: if the resolver rejects the agent's
  // configured model (not in the provider catalog), tell the user which model
  // is actually about to run instead of letting the default masquerade as it.
  const resolvedModel = requestedResolvedModel;
  if (info.model && resolvedModel !== info.model) {
    const sysMsg = agentService.addSystemMessage(
      agentId,
      `⚠ Configured model "${info.model}" is not in the ${provider} catalog — running "${resolvedModel}" instead. ` +
      `Pick a model from the dropdown to clear this.`,
    );
    broadcast({ type: 'message', message: sysMsg });
  }
  if (provider === 'codex' && info.reasoningLevel && resolvedReasoningLevel !== info.reasoningLevel) {
    const sysMsg = agentService.addSystemMessage(
      agentId,
      `Reasoning effort "${info.reasoningLevel}" is not supported by "${resolvedModel}" — using "${resolvedReasoningLevel}" for this turn.`,
    );
    broadcast({ type: 'message', message: sysMsg });
  }

  const createAttemptContext = (attemptId: number): AgentRunContext => {
    const isCurrent = () => acceptingEvents
      && activeAttemptId === attemptId
      && turnBuffers.get(agentId) === turn
      && (turnEpochs.get(agentId) ?? 0) === turnEpochAtStart;
    return {
      paneId: agentId,
      cwd: info.cwd,
      referencePaths: validReferencePaths,
      systemPrompt: appendedSystemPrompt,
      model: resolvedModel,
      reasoningLevel: resolvedReasoningLevel,
      imagePaths: options.imagePaths,

      getSessionId(): string | null {
        return sessionIdForAdapter;
      },
      updateSessionId(nextSessionId: string): void {
        if (!isCurrent()) return;
        // Claim the new session for this turn's provider/model. If the user
        // swaps either again, the next turn starts fresh.
        agentService.setCurrentSession(agentId, provider, resolvedModel, nextSessionId);
      },
      emitChatEvent(_event: unknown): void {
        if (!isCurrent()) return;
        // Every valid provider event proves the process is alive, including
        // new event kinds that the normalized adapter has not learned yet.
        activeWatchdog?.touch();
        liveTurnStateService.touch(agentId, turn.liveTurnId);
        broadcastLiveTurnState(agentId);
      },
      emitAgentEvent(event: AgentEvent): void {
        if (!isCurrent()) return;
        activeWatchdog?.touch();
        handleEvent(agentId, event);
      },
      emitStatus(status: string): void {
        if (!isCurrent()) return;
        const wire = status === 'thinking' ? 'thinking' : status === 'error' ? 'error' : 'working';
        agentService.setStatus(agentId, wire as any);
      },
      emitActivity(_activity): void {
        // No wire surface yet; reserved for the activity bar.
      },
      emitSystemMessage(message: string): void {
        if (!isCurrent()) return;
        const bounded = boundedChatText(message);
        const sysMsg = agentService.addSystemMessage(agentId, bounded);
        turn.persistedSystemMessages.add(bounded.trim());
        broadcast({ type: 'message', message: sysMsg });
      },
    };
  };

  try {
    let didStaleSessionRetry = false;
    let didExpiredAuthRetry = false;
    while (true) {
      // 7) Create handle, register, and run. Long-lived goal processes are
      //    unlimited unless the operator explicitly configured an inactivity
      //    timeout for this server.
      const attemptId = ++activeAttemptId;
      const ctx = createAttemptContext(attemptId);
      const state = adapter.createState(ctx);
      const handle = adapter.createHandle(promptBody, ctx, state);
      currentHandles.set(agentId, handle);
      const watchdog = createInactivityWatchdog({
        timeoutMs: TURN_INACTIVITY_TIMEOUT_MS,
        onTimeout: () => {
          const inactivityTimeoutMs = TURN_INACTIVITY_TIMEOUT_MS;
          console.warn(
            `[chat] ${provider} turn for ${agentId} reached the configured ` +
            `${Math.round((inactivityTimeoutMs ?? 0) / 60000)}min inactivity limit`,
          );
          if (!turn.abortReason) turn.abortReason = 'timeout';
          try {
            void Promise.resolve(handle.kill()).catch((e) => {
              console.error(`[chat] watchdog kill(${agentId}) failed:`, e);
            });
          } catch (e) {
            console.error(`[chat] watchdog kill(${agentId}) failed:`, e);
          }
        },
      });
      activeWatchdog = watchdog;
      watchdog.start();

      let result;
      try {
        result = await handle.run();
      } finally {
        watchdog.stop();
        if (activeWatchdog === watchdog) activeWatchdog = null;
        if (activeAttemptId === attemptId) activeAttemptId++;
        // Identity-guarded: never clobber a newer turn's handle.
        if (currentHandles.get(agentId) === handle) currentHandles.delete(agentId);
      }

      if (result?.recoverableError === 'stale-session' && !didStaleSessionRetry && turn.retrySafe) {
        didStaleSessionRetry = true;
        console.warn(`[chat] stale ${provider} session for ${agentId}; clearing saved session and retrying fresh`);
        agentService.clearCurrentSession(agentId);
        sessionIdForAdapter = null;
        promptBody = prependPriorHistory(agentId, content);
        // Drop anything streamed before the resume failure surfaced, so the
        // retried turn's output isn't duplicated in the flushed message.
        turn.accumulatedText = '';
        turn.lastResultEmitted = null;
        turn.lastAssistantSnapshot = null;
        turn.lastErrorMessage = null;
        turn.liveTurnId = liveTurnStateService.begin(agentId, provider).turnId;
        broadcastLiveTurnState(agentId, true);
        continue;
      }
      if (result?.recoverableError === 'stale-session') {
        const recoveryError = result.errorMessage || 'session was not found';
        const recoveryMessage = `${provider === 'codex' ? 'Codex' : 'Claude'} session recovery failed: ${recoveryError}`;
        const sysMsg = agentService.addSystemMessage(
          agentId,
          recoveryMessage,
        );
        turn.lastErrorMessage = recoveryError;
        turn.persistedSystemMessages.add(recoveryMessage);
        broadcast({ type: 'message', message: sysMsg });
      }

      // The CLI's OAuth access token expired as this turn spawned. It refreshes
      // the token in place, so one immediate re-spawn normally succeeds. Unlike
      // a stale session the conversation is intact — keep the session id and the
      // prompt, and only reset the buffers holding the failed attempt's output.
      if (result?.recoverableError === 'expired-auth' && shouldAutomaticallyRetryExpiredAuth(didExpiredAuthRetry, turn.retrySafe)) {
        didExpiredAuthRetry = true;
        console.warn(`[chat] expired ${provider} OAuth token for ${agentId}; retrying once with the refreshed token`);
        turn.accumulatedText = '';
        turn.lastResultEmitted = null;
        turn.lastAssistantSnapshot = null;
        turn.lastErrorMessage = null;
        turn.liveTurnId = liveTurnStateService.begin(agentId, provider).turnId;
        broadcastLiveTurnState(agentId, true);
        continue;
      }
      if (result?.recoverableError === 'expired-auth') {
        const authError = result.errorMessage || 'OAuth access token has expired';
        const incident = authRecoveryStore.record({
          agentId,
          provider,
          messageId: turn.userMessageId,
          reasonCode: 'access-token-expired',
          state: 'reauthentication-required',
          retrySafe: turn.retrySafe,
          sideEffectRisk: !turn.retrySafe,
          automaticRetryUsed: didExpiredAuthRetry,
        });
        const authMessage = incident?.userMessage || authError;
        const sysMsg = agentService.addSystemMessage(agentId, authMessage);
        turn.lastErrorMessage = authError;
        turn.persistedSystemMessages.add(authMessage);
        broadcast({ type: 'message', message: sysMsg });
      }
      break;
    }
  } catch (e: any) {
    console.error(`[chat] adapter run failed for ${agentId}:`, e);
    const errorMessage = boundedChatText(e?.message || String(e));
    turn.lastErrorMessage = errorMessage;
  } finally {
    acceptingEvents = false;
    activeAttemptId++;
    // Flush any process-level result that was not already persisted at a
    // provider turn boundary. Stopped, failed, and empty exits also receive a
    // durable outcome so an accepted user message can never disappear silently.
    // Use the local `turn` (not the map) so this turn always flushes its own
    // buffer even if a newer turn has since replaced the map entry.
    const turnState = turn;
    const providerSnapshot = liveTurnStateService.get(agentId);
    if (!turnState.abortReason && providerSnapshot?.turnId === turn.liveTurnId
        && providerSnapshot.providerTurn?.status === 'stopped') {
      turnState.abortReason = 'provider';
    }
    const finalization = resolveTurnFinalization({
      provider,
      accumulatedText: turnState.accumulatedText,
      lastResultEmitted: turnState.lastResultEmitted,
      lastAssistantSnapshot: turnState.lastAssistantSnapshot,
      lastPersistedResult: turnState.lastPersistedResult,
      abortReason: turnState.abortReason,
      errorMessage: turnState.lastErrorMessage,
      persistedSystemMessages: [...turnState.persistedSystemMessages],
    });
    const outcomeStatus = resolveTurnOutcome({
      provider,
      accumulatedText: turnState.accumulatedText,
      lastResultEmitted: turnState.lastResultEmitted,
      lastAssistantSnapshot: turnState.lastAssistantSnapshot,
      lastPersistedResult: turnState.lastPersistedResult,
      abortReason: turnState.abortReason,
      errorMessage: turnState.lastErrorMessage,
      persistedSystemMessages: [...turnState.persistedSystemMessages],
    });

    if (outcomeStatus === 'completed') {
      authRecoveryStore.resolveAgent(agentId);
    } else if (turnState.authBlocked) {
      const snapshot = currentAuthCoordinator().getSnapshot(provider);
      authRecoveryStore.record({
        agentId,
        provider,
        messageId: turnState.userMessageId,
        reasonCode: snapshot.reasonCode,
        state: snapshot.state === 'unknown' ? 'reauthentication-required' : snapshot.state,
        cliVersion: snapshot.cliVersion,
        retrySafe: true,
        sideEffectRisk: false,
        automaticRetryUsed: false,
      });
    }

    if (finalization.assistantText) {
      persistAssistantResult(agentId, finalization.assistantText, turnState);
    }
    if (finalization.systemText) {
      const sysMsg = agentService.addSystemMessage(agentId, finalization.systemText);
      turnState.persistedSystemMessages.add(finalization.systemText);
      broadcast({ type: 'message', message: sysMsg });
    }

    // Ground-truth model check: if the CLI reported serving this turn with a
    // different model than we requested, latch the mismatch — this blocks all
    // further sends on this agent until the user resolves it. Tier suffixes
    // ("[1m]") are stripped so a context-tier difference alone doesn't trip it.
    const ranModel = turnState?.modelRan;
    const ranModelCanDriveMismatch = provider !== 'claude' || isRealClaudeModelId(ranModel);
    if (ranModel && ranModelCanDriveMismatch && resolvedModel && stripModelTier(ranModel) !== stripModelTier(resolvedModel)) {
      agentService.setModelMismatch(agentId, resolvedModel, ranModel);
    }

    // Persist the per-turn usage rollup. No-ops if every counter is zero
    // (a turn that errored before any API call). Triggers a usage_summary
    // broadcast so the bottom-bar tracker updates immediately. The model is
    // stamped from the CLI-reported ground truth when available so the Tokens
    // tab can break spend down per model.
    if (turnState) {
      usageService.record(agentId, provider, turnState.turnUsage, { model: turnState.modelRan || resolvedModel });
    }

    // Identity-guarded: never delete a newer turn's buffer.
    if (turnBuffers.get(agentId) === turn) turnBuffers.delete(agentId);

    const finalLiveState = liveTurnStateService.finalize(agentId, turn.liveTurnId);
    if (finalLiveState) broadcast({ type: 'live_turn_state', state: finalLiveState });
    liveStateLastBroadcastAt.delete(agentId);

    await documentService.releaseLocksForAgent(agentId);
    // If a newer turn is already running (stop + immediate resend race),
    // don't clobber its status or fire idle hooks under it — it will run
    // its own finalization when it completes.
    const newerTurnRunning = currentHandles.has(agentId);
    if (!newerTurnRunning) {
      agentService.finishTurn(agentId, {
        status: outcomeStatus,
        at: Date.now(),
        detail: turnState.lastErrorMessage || undefined,
      });
    }
    await persistenceService.saveNow();
    if (!newerTurnRunning) await agentService.notifyIdle(agentId);
  }
}

// --- Public API -------------------------------------------------------------

export const chatService = {
  /**
   * Entry point for text and image-backed chat turns.
   * Serializes per-agent via the sendLocks chain so concurrent calls don't
   * interleave.
   */
  async sendMessage(agentId: string, content: string, source?: 'qa', options: ChatTurnOptions = {}): Promise<void> {
    // Capture the epoch at enqueue time. If resetLock() bumps it while this
    // send waits in the queue (user hit Stop), the send no-ops on dequeue.
    const epochAtEnqueue = turnEpochs.get(agentId) ?? 0;
    const runIfCurrent = () => {
      if ((turnEpochs.get(agentId) ?? 0) !== epochAtEnqueue) {
        console.warn(`[chat] dropping queued message for ${agentId} — agent was stopped while it waited`);
        return Promise.resolve();
      }
      return runChatTurn(agentId, content, source, options);
    };
    const prev = sendLocks.get(agentId) ?? Promise.resolve();
    const execution = prev.then(runIfCurrent, runIfCurrent);
    // Keep the internal queue usable after failure, but return the original
    // execution promise so persistence/infrastructure errors reach callers.
    const queueTail = execution.catch(e => {
      console.error(`[chat] sendMessage(${agentId}) error:`, e);
    });
    sendLocks.set(agentId, queueTail);
    try {
      return await execution;
    } finally {
      if (sendLocks.get(agentId) === queueTail) sendLocks.delete(agentId);
    }
  },

  /**
   * Ask the adapter to terminate the in-flight turn gracefully. The adapter's
   * run() will resolve shortly; the finally block in runChatTurn flushes any
   * partial assistant output with the [Stopped: ...] marker.
   */
  stop(agentId: string, reason: 'user' | 'timeout' | 'system' = 'user'): void {
    const turn = turnBuffers.get(agentId);
    if (turn) turn.abortReason = reason;
    const handle = currentHandles.get(agentId);
    if (!handle) return;
    try {
      void Promise.resolve(handle.stop()).catch((e) => {
        console.error(`[chat] stop(${agentId}) failed:`, e);
      });
    } catch (e) {
      console.error(`[chat] stop(${agentId}) failed:`, e);
    }
  },

  /** Force-kill the adapter's subprocess immediately. */
  kill(agentId: string): void {
    const turn = turnBuffers.get(agentId);
    if (turn) turn.abortReason = 'user';
    const handle = currentHandles.get(agentId);
    if (!handle) return;
    try {
      void Promise.resolve(handle.kill()).catch((e) => {
        console.error(`[chat] kill(${agentId}) failed:`, e);
      });
    } catch (e) {
      console.error(`[chat] kill(${agentId}) failed:`, e);
    }
  },

  /**
   * Cancel queued sends for an agent. Called from agent.service when stop /
   * kill / remove runs. Bumps the epoch so already-queued continuations
   * no-op on dequeue; deliberately does NOT delete the lock chain — new sends
   * must stay serialized behind the cancelled turn's teardown, otherwise they
   * race it for the shared turn buffer and handle registry.
   */
  resetLock(agentId: string): void {
    turnEpochs.set(agentId, (turnEpochs.get(agentId) ?? 0) + 1);
  },

  /** True if an adapter handle is currently running a turn for this agent. */
  hasActiveTurn(agentId: string): boolean {
    return currentHandles.has(agentId);
  },

  /**
   * Wait (capped) for all in-flight turns to finish unwinding. Used at
   * shutdown so killed turns' finally blocks (which flush partial assistant
   * messages and persist) get a chance to run before the final save.
   */
  async waitForAllTurns(capMs = 3000): Promise<void> {
    await Promise.race([
      Promise.allSettled([...sendLocks.values()]),
      new Promise<void>(resolve => setTimeout(resolve, capMs)),
    ]);
  },

  /** Wait for one agent's queued/active turn teardown without hanging CRUD. */
  async waitForAgentTurn(agentId: string, capMs = 3000): Promise<boolean> {
    const pending = sendLocks.get(agentId);
    if (!pending && !currentHandles.has(agentId)) return true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const completed = pending
      ? pending.then(() => true, () => true)
      : new Promise<boolean>(() => {});
    const timedOut = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), capMs);
    });
    try {
      const settled = await Promise.race([completed, timedOut]);
      return settled && !currentHandles.has(agentId);
    } finally {
      if (timer) clearTimeout(timer);
    }
  },
};
