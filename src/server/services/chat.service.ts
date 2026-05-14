import type { AgentEvent } from '../agents/events';
import type { AgentHandle, AgentRunContext } from '../agents/types';
import type { ChatAgentKind } from '../agents/agent-kinds';
import { getAgentAdapter, resolveAgentModel } from '../agents/registry';
import { broadcast } from '../broadcast';
import { agentService } from './agent.service';
import { documentService } from './document.service';
import { persistenceService } from './persistence.service';
import { promptBuilderService } from './prompt-builder.service';

// --- HMR-safe state ---------------------------------------------------------

// Per-agent FIFO of in-flight + queued turns. Each new send chains onto the
// prior one's promise so calls to the same agent serialize cleanly.
const sendLocks: Map<string, Promise<void>> = (globalThis as any).__chatSendLocks ??= new Map();

// Per-agent in-flight adapter handle. Populated when an adapter is running,
// cleared when its run() resolves. stop() / kill() route through here.
const currentHandles: Map<string, AgentHandle> = (globalThis as any).__chatCurrentHandles ??= new Map();

// Per-agent turn buffer: accumulated text-delta content so we can flush a
// single 'assistant' message at the end (with an abort marker if stopped).
interface TurnBuffer {
  accumulatedText: string;
  lastResultEmitted: string | null;
  abortReason?: 'user' | 'timeout' | 'system';
}
const turnBuffers: Map<string, TurnBuffer> = (globalThis as any).__chatTurnBuffers ??= new Map();

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

function handleEvent(agentId: string, event: AgentEvent): void {
  switch (event.type) {
    case 'text-delta': {
      const turn = turnBuffers.get(agentId);
      if (turn) turn.accumulatedText += event.text;
      broadcast({ type: 'output', agentId, content: event.text, stream: 'stdout' });
      return;
    }

    case 'thinking-delta': {
      broadcast({ type: 'thinking_output', agentId, content: event.text });
      return;
    }

    case 'stderr': {
      broadcast({ type: 'output', agentId, content: event.text, stream: 'stderr' });
      return;
    }

    case 'tool-call-start': {
      // Sniff Write/Edit on .plans/*.md and forward to documentService for the
      // live-document sync. Other tool calls are surfaced as inline breadcrumbs.
      sniffPlanWrite(agentId, event.toolName, event.input);

      // Render `[ToolName: useful summary]` when we have something useful, or
      // just `[ToolName]` when we don't — avoids the [Glob: Glob] redundancy
      // when the summarizer can't extract anything specific from the input.
      const summary = (event.summary ?? '').trim();
      const breadcrumb = summary && summary !== event.toolName
        ? `\n[${event.toolName}: ${summary}]\n`
        : `\n[${event.toolName}]\n`;

      // Accumulate into the turn buffer so the breadcrumb survives in the
      // final assistant message (legacy parity — tool calls were part of the
      // saved chat record, not just transient live output).
      const turn = turnBuffers.get(agentId);
      if (turn) turn.accumulatedText += breadcrumb;

      broadcast({ type: 'output', agentId, content: breadcrumb, stream: 'stdout' });
      return;
    }

    case 'tool-call-end': {
      // Tool results are surfaced by the next assistant turn's narrative; no
      // separate wire event needed.
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
      });
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
      return;
    }

    case 'result': {
      // Some providers (and Claude's `result` event itself) emit a final
      // non-streamed result. We keep it as a fallback in case nothing streamed
      // via text-delta — the finally block flushes whichever ended up longer.
      const turn = turnBuffers.get(agentId);
      if (turn) turn.lastResultEmitted = event.text;
      return;
    }

    case 'error': {
      broadcast({ type: 'error', message: event.message, agentId });
      return;
    }

    case 'finish': {
      // The runChatTurn() finally block handles status reset + buffer flush.
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

async function runChatTurn(agentId: string, content: string, source?: 'qa'): Promise<void> {
  const info = agentService.getAgent(agentId);
  if (!info) {
    console.warn(`[chat] sendMessage: agent not found ${agentId}`);
    return;
  }

  // 1) Append user turn to history + broadcast.
  const userMsg = agentService.appendMessage(agentId, 'user', content, undefined, undefined, source);
  broadcast({ type: 'message', message: userMsg });

  // 2) Status: working. Adapter status events will refine to thinking/responding.
  agentService.setStatus(agentId, 'working');

  // 3) Resolve provider + adapter.
  const provider: ChatAgentKind = (info.provider as ChatAgentKind | undefined) ?? 'claude';
  const adapter = getAgentAdapter(provider);
  if (!adapter) {
    const sysMsg = agentService.addSystemMessage(
      agentId,
      `No adapter registered for provider '${provider}'. Phase 2 wires Claude; Phase 3 adds Codex.`,
    );
    broadcast({ type: 'message', message: sysMsg });
    agentService.setStatus(agentId, 'idle');
    await agentService.notifyIdle(agentId);
    return;
  }

  // 4) Build the appended system prompt + resolve which reference paths exist.
  const { appendedSystemPrompt, validReferencePaths } = promptBuilderService.build(
    info,
    agentService.getSharedContext(),
  );

  // 5) Decide --resume vs fresh start. We --resume only when the agent's
  //    current session is owned by THIS provider; if the user just swapped
  //    providers, we start fresh and prepend the prior UI chat history so
  //    the new provider has cross-provider context. After this turn finishes,
  //    setCurrentSession claims the session for the (now-current) provider.
  const previousSessionProvider = agentService.getCurrentSessionProvider(agentId);
  const previousSessionId = agentService.getCurrentSessionId(agentId);
  const isProviderMatch = previousSessionProvider === provider && !!previousSessionId;
  const sessionIdForAdapter = isProviderMatch ? previousSessionId : null;

  // Build the prompt body. On a swap, prepend the prior conversation as
  // delimited context so the new provider sees what the previous provider
  // saw. We re-fetch messages here so it includes the user turn we just
  // appended (which is correct — the model sees its own user prompt as
  // "User: ..." within the history block, mirroring the live conversation).
  const promptBody = isProviderMatch
    ? content
    : prependPriorHistory(agentId, content);

  // 6) Build AgentRunContext — closures over agentId so emit callbacks route.
  const turn: TurnBuffer = { accumulatedText: '', lastResultEmitted: null };
  turnBuffers.set(agentId, turn);

  const ctx: AgentRunContext = {
    paneId: agentId,
    cwd: info.cwd,
    referencePaths: validReferencePaths,
    systemPrompt: appendedSystemPrompt,
    model: resolveAgentModel(provider, info.model),
    reasoningLevel: info.reasoningLevel,

    getSessionId(): string | null {
      return sessionIdForAdapter;
    },
    updateSessionId(nextSessionId: string): void {
      // Claim the new session for this turn's provider. If the user swaps
      // providers again, this lookup will detect the mismatch on the next
      // turn and start fresh.
      agentService.setCurrentSession(agentId, provider, nextSessionId);
    },
    emitChatEvent(_event: unknown): void {
      // Raw provider events currently have no UI surface. Hook target for
      // future plugins (e.g. transcript logging, debug dumps).
    },
    emitAgentEvent(event: AgentEvent): void {
      handleEvent(agentId, event);
    },
    emitStatus(status: string): void {
      const wire = status === 'thinking' ? 'thinking' : status === 'error' ? 'error' : 'working';
      agentService.setStatus(agentId, wire as any);
    },
    emitActivity(_activity): void {
      // No wire surface yet; reserved for the activity bar.
    },
    emitSystemMessage(message: string): void {
      const sysMsg = agentService.addSystemMessage(agentId, message);
      broadcast({ type: 'message', message: sysMsg });
    },
  };

  // 7) Create handle, register, run.
  const state = adapter.createState(ctx);
  const handle = adapter.createHandle(promptBody, ctx, state);
  currentHandles.set(agentId, handle);

  try {
    await handle.run();
  } catch (e: any) {
    console.error(`[chat] adapter run failed for ${agentId}:`, e);
    const sysMsg = agentService.addSystemMessage(agentId, `Agent run failed: ${e?.message || String(e)}`);
    broadcast({ type: 'message', message: sysMsg });
  } finally {
    currentHandles.delete(agentId);

    // Flush the final assistant message. Prefer streamed text-delta accumulation;
    // fall back to the result event's text if nothing streamed (rare path).
    const turnState = turnBuffers.get(agentId);
    const streamed = (turnState?.accumulatedText ?? '').trim();
    const resultText = (turnState?.lastResultEmitted ?? '').trim();
    let finalText = streamed.length >= resultText.length ? streamed : resultText;

    if (finalText) {
      if (turnState?.abortReason) {
        const marker = turnState.abortReason === 'timeout'
          ? '[Stopped: time limit reached]'
          : turnState.abortReason === 'system'
            ? '[Stopped by system]'
            : '[Stopped by user]';
        finalText = finalText + '\n\n' + marker;
      }
      // Stamp the provider that produced this turn so the chat UI can render
      // the correct role label ('Claude' vs 'Codex') per-message — historic
      // messages without this field display 'Claude' for backward compat.
      const assistantMsg = agentService.appendMessage(agentId, 'assistant', finalText, undefined, undefined, undefined, provider);
      broadcast({ type: 'message', message: assistantMsg });
    }
    turnBuffers.delete(agentId);

    await documentService.releaseLocksForAgent(agentId);
    agentService.setStatus(agentId, 'idle');
    await persistenceService.saveNow();
    await agentService.notifyIdle(agentId);
  }
}

// --- Public API -------------------------------------------------------------

export const chatService = {
  /**
   * Entry point for `send_message`, `send_image`, `send_images`, and
   * `broadcast_message`. Serializes per-agent via the sendLocks chain so
   * concurrent calls don't interleave.
   */
  async sendMessage(agentId: string, content: string, source?: 'qa'): Promise<void> {
    const prev = sendLocks.get(agentId) ?? Promise.resolve();
    const current = prev.then(
      () => runChatTurn(agentId, content, source),
      () => runChatTurn(agentId, content, source),
    ).catch(e => { console.error(`[chat] sendMessage(${agentId}) error:`, e); });
    sendLocks.set(agentId, current);
    return current;
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
    try { handle.stop(); } catch (e) { console.error(`[chat] stop(${agentId}) failed:`, e); }
  },

  /** Force-kill the adapter's subprocess immediately. */
  kill(agentId: string): void {
    const turn = turnBuffers.get(agentId);
    if (turn) turn.abortReason = 'user';
    const handle = currentHandles.get(agentId);
    if (!handle) return;
    try { handle.kill(); } catch (e) { console.error(`[chat] kill(${agentId}) failed:`, e); }
  },

  /**
   * Drop the per-agent sendLock chain. Called from agent.service when stop /
   * kill / remove runs so queued sends behind a cancelled turn don't fire.
   */
  resetLock(agentId: string): void {
    sendLocks.delete(agentId);
  },
};
