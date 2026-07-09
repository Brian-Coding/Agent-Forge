import type { AgentEvent } from '../agents/events';
import type { AgentHandle, AgentRunContext } from '../agents/types';
import { stripModelTier, type ChatAgentKind } from '../agents/agent-kinds';
import { getAgentAdapter, resolveAgentModel } from '../agents/registry';
import { broadcast } from '../broadcast';
import { agentService } from './agent.service';
import { documentService } from './document.service';
import { persistenceService } from './persistence.service';
import { promptBuilderService } from './prompt-builder.service';
import { usageService } from './usage.service';

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
  // Per-turn usage accumulator. Each adapter `usage` event sums its deltas
  // here; at turn-finalize the rolled-up totals get one entry in the usage
  // log via usageService.record() — so the log grows at most one row per
  // turn, not one row per internal API sub-call.
  turnUsage: { inputTokens: number; outputTokens: number; costUsd: number; turns: number };
  modelRan?: string;
}
const turnBuffers: Map<string, TurnBuffer> = (globalThis as any).__chatTurnBuffers ??= new Map();

// Per-agent epoch counter. Bumped by resetLock() (stop/kill/remove) so sends
// queued behind a cancelled turn detect the bump when they finally dequeue
// and no-op instead of firing a turn the user already abandoned. Replaces the
// old "delete the lock chain" approach, which didn't actually cancel queued
// continuations AND let a brand-new send run concurrently with the old
// turn's teardown (clobbering turnBuffers/currentHandles).
const turnEpochs: Map<string, number> = (globalThis as any).__chatTurnEpochs ??= new Map();

// Inactivity watchdog: if an adapter subprocess emits nothing for this long,
// kill it and finalize the turn — a hung CLI (network stall, auth prompt,
// stdin deadlock) must not wedge the agent forever, since every subsequent
// message queues behind the dead turn.
const TURN_INACTIVITY_TIMEOUT_MS = (() => {
  const fromEnv = parseInt(process.env.AGENT_TURN_INACTIVITY_MS || '', 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 15 * 60_000;
})();

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
      if (/No conversation found with session ID/i.test(event.text)) return;
      broadcast({ type: 'output', agentId, content: event.text, stream: 'stderr' });
      return;
    }

    case 'tool-call-start': {
      // Sniff Write/Edit on .plans/*.md and forward to documentService for the
      // live-document sync. Other tool calls stay hidden to keep chat readable.
      sniffPlanWrite(agentId, event.toolName, event.input);
      const label = event.summary ? `${event.toolName}: ${event.summary}` : `Using ${event.toolName}`;
      broadcast({ type: 'agent_activity', agentId, label, timestamp: Date.now() });
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
        modelRan: event.modelRan,
      });
      // Accumulate into the per-turn buffer for the usage-log record at finalize.
      const turn = turnBuffers.get(agentId);
      if (turn) {
        if (typeof event.inputTokensDelta === 'number') turn.turnUsage.inputTokens += event.inputTokensDelta;
        if (typeof event.outputTokensDelta === 'number') turn.turnUsage.outputTokens += event.outputTokensDelta;
        if (typeof event.costUsdDelta === 'number') turn.turnUsage.costUsd += event.costUsdDelta;
        if (typeof event.turnsDelta === 'number') turn.turnUsage.turns += event.turnsDelta;
        if (typeof event.modelRan === 'string' && event.modelRan) turn.modelRan = event.modelRan;
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

  const requestedResolvedModel = resolveAgentModel(provider, info.model);

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
    accumulatedText: '',
    lastResultEmitted: null,
    turnUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0 },
  };
  turnBuffers.set(agentId, turn);

  // Watchdog activity clock — any adapter event counts as liveness.
  let lastActivity = Date.now();

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

  const ctx: AgentRunContext = {
    paneId: agentId,
    cwd: info.cwd,
    referencePaths: validReferencePaths,
    systemPrompt: appendedSystemPrompt,
    model: resolvedModel,
    reasoningLevel: info.reasoningLevel,

    getSessionId(): string | null {
      return sessionIdForAdapter;
    },
    updateSessionId(nextSessionId: string): void {
      // Claim the new session for this turn's provider/model. If the user swaps
      // either again, this lookup will detect the mismatch on the next turn and
      // start fresh.
      agentService.setCurrentSession(agentId, provider, resolvedModel, nextSessionId);
    },
    emitChatEvent(_event: unknown): void {
      // Raw provider events currently have no UI surface. Hook target for
      // future plugins (e.g. transcript logging, debug dumps).
    },
    emitAgentEvent(event: AgentEvent): void {
      lastActivity = Date.now();
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

  try {
    let didStaleSessionRetry = false;
    while (true) {
      // 7) Create handle, register, run — under an inactivity watchdog so a
      //    hung CLI can't wedge the agent (and its send queue) forever.
      const state = adapter.createState(ctx);
      const handle = adapter.createHandle(promptBody, ctx, state);
      currentHandles.set(agentId, handle);
      lastActivity = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > TURN_INACTIVITY_TIMEOUT_MS) {
          console.warn(`[chat] ${provider} turn for ${agentId} silent for ${Math.round(TURN_INACTIVITY_TIMEOUT_MS / 60000)}min — killing hung process`);
          if (!turn.abortReason) turn.abortReason = 'timeout';
          try { handle.kill(); } catch (e) { console.error(`[chat] watchdog kill(${agentId}) failed:`, e); }
          // Re-arm so a process that survives the kill gets re-killed next
          // window instead of being hammered every 30s tick.
          lastActivity = Date.now();
        }
      }, 30_000);

      let result;
      try {
        result = await handle.run();
      } finally {
        clearInterval(watchdog);
        // Identity-guarded: never clobber a newer turn's handle.
        if (currentHandles.get(agentId) === handle) currentHandles.delete(agentId);
      }

      if (result?.recoverableError === 'stale-session' && !didStaleSessionRetry) {
        didStaleSessionRetry = true;
        console.warn(`[chat] stale ${provider} session for ${agentId}; clearing saved session and retrying fresh`);
        agentService.clearCurrentSession(agentId);
        sessionIdForAdapter = null;
        promptBody = prependPriorHistory(agentId, content);
        // Drop anything streamed before the resume failure surfaced, so the
        // retried turn's output isn't duplicated in the flushed message.
        turn.accumulatedText = '';
        turn.lastResultEmitted = null;
        continue;
      }
      if (result?.recoverableError === 'stale-session') {
        const sysMsg = agentService.addSystemMessage(
          agentId,
          `${provider === 'codex' ? 'Codex' : 'Claude'} session recovery failed: ${result.errorMessage || 'session was not found'}`,
        );
        broadcast({ type: 'message', message: sysMsg });
      }
      break;
    }
  } catch (e: any) {
    console.error(`[chat] adapter run failed for ${agentId}:`, e);
    const sysMsg = agentService.addSystemMessage(agentId, `Agent run failed: ${e?.message || String(e)}`);
    broadcast({ type: 'message', message: sysMsg });
  } finally {
    // Flush the final assistant message. Claude streams the final response, so
    // prefer accumulated deltas there. Codex also streams progress/status text;
    // its --output-last-message result is the canonical persisted answer.
    // Use the local `turn` (not the map) so this turn always flushes its own
    // buffer even if a newer turn has since replaced the map entry.
    const turnState = turn;
    const streamed = (turnState?.accumulatedText ?? '').trim();
    const resultText = (turnState?.lastResultEmitted ?? '').trim();
    let finalText = provider === 'codex' && resultText
      ? resultText
      : (streamed.length >= resultText.length ? streamed : resultText);

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
      const assistantMsg = agentService.appendMessage(agentId, 'assistant', finalText, undefined, undefined, undefined, provider, turnState?.modelRan || resolvedModel);
      broadcast({ type: 'message', message: assistantMsg });
    }

    // Ground-truth model check: if the CLI reported serving this turn with a
    // different model than we requested, latch the mismatch — this blocks all
    // further sends on this agent until the user resolves it. Tier suffixes
    // ("[1m]") are stripped so a context-tier difference alone doesn't trip it.
    const ranModel = turnState?.modelRan;
    if (ranModel && resolvedModel && stripModelTier(ranModel) !== stripModelTier(resolvedModel)) {
      agentService.setModelMismatch(agentId, resolvedModel, ranModel);
    }

    // Persist the per-turn usage rollup. No-ops if every counter is zero
    // (a turn that errored before any API call). Triggers a usage_summary
    // broadcast so the bottom-bar tracker updates immediately.
    if (turnState) {
      usageService.record(agentId, provider, turnState.turnUsage);
    }

    // Identity-guarded: never delete a newer turn's buffer.
    if (turnBuffers.get(agentId) === turn) turnBuffers.delete(agentId);

    await documentService.releaseLocksForAgent(agentId);
    // If a newer turn is already running (stop + immediate resend race),
    // don't clobber its status or fire idle hooks under it — it will run
    // its own finalization when it completes.
    const newerTurnRunning = currentHandles.has(agentId);
    if (!newerTurnRunning) agentService.setStatus(agentId, 'idle');
    await persistenceService.saveNow();
    if (!newerTurnRunning) await agentService.notifyIdle(agentId);
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
    // Capture the epoch at enqueue time. If resetLock() bumps it while this
    // send waits in the queue (user hit Stop), the send no-ops on dequeue.
    const epochAtEnqueue = turnEpochs.get(agentId) ?? 0;
    const runIfCurrent = () => {
      if ((turnEpochs.get(agentId) ?? 0) !== epochAtEnqueue) {
        console.warn(`[chat] dropping queued message for ${agentId} — agent was stopped while it waited`);
        return Promise.resolve();
      }
      return runChatTurn(agentId, content, source);
    };
    const prev = sendLocks.get(agentId) ?? Promise.resolve();
    const current = prev.then(runIfCurrent, runIfCurrent)
      .catch(e => { console.error(`[chat] sendMessage(${agentId}) error:`, e); });
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
};
