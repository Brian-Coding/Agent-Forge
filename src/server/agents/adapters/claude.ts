import { existsSync } from 'fs';
import { extname, win32 as win32Path } from 'path';
import {
  ArgvTooLongError,
  createCliEnv,
  createProcessUnwindSignal,
  killProcessTree,
  resolveCliBinary,
  safeSpawn,
  type ProcessTerminationResult,
  waitForProcessExit,
  waitForOperationOrUnwind,
} from '../../utils';
import { isRealClaudeModelId, stripModelTier } from '../agent-kinds';
import { persistenceService } from '../../services/persistence.service';
import { summarizeToolInput, type AgentEvent } from '../events';
import { drainStreamToString, parseNdjsonLines, flushNdjsonLeftover } from '../stream-utils';
import type { AgentAdapter, AgentHandle, AgentRunContext } from '../types';
import { collectBoundedProcess } from '../../services/bounded-subprocess';

/**
 * Claude CLI adapter. Preserves agent-forge's existing invocation:
 *   claude --print --output-format stream-json --verbose --dangerously-skip-permissions
 *          --append-system-prompt <built prompt>
 *          --add-dir <ref>...
 *          [--model <model>]
 *          [--resume <sessionId>]
 *
 * Prompt is fed via stdin (newline-terminated, then EOF).
 *
 * Stream-json event mapping:
 *   system/init  → emit 'session' (and call ctx.updateSessionId)
 *   assistant    → emit 'usage' (delta tokens), then per content block:
 *                    type=thinking → emit 'status:thinking' + 'thinking-delta'
 *                    type=text     → emit live provider commentary; final result stays response
 *                    type=tool_use → emit 'tool-call-start'
 *   user         → per content block: type=tool_result → emit 'tool-call-end'
 *   result       → emit 'usage' (cost+turns deltas, contextLimit snapshot) + 'result'
 *   stderr       → emit 'stderr' chunks live
 *   exit         → emit 'finish'
 *
 * The bridge (chat.service) accumulates usage deltas onto the agent's
 * running totals and broadcasts `token_usage` with the snapshot.
 */
export interface ClaudeRunState {
  streamedThinking: string;
  streamedText: string;
  lastRenderedContentKind: 'thinking' | 'text' | null;
  currentMessageId: string | null;
  currentIsSubagent: boolean;
  startedToolIds: Set<string>;
  pendingSessionId: string | null;
}

export function createClaudeRunState(): ClaudeRunState {
  return {
    streamedThinking: '',
    streamedText: '',
    lastRenderedContentKind: null,
    currentMessageId: null,
    currentIsSubagent: false,
    startedToolIds: new Set<string>(),
    pendingSessionId: null,
  };
}

function snapshotSuffix(full: string, streamed: string): string {
  if (!full) return '';
  if (!streamed) return full;
  if (full === streamed || streamed.endsWith(full)) return '';
  if (full.startsWith(streamed)) return full.slice(streamed.length);
  // The provider changed the completed snapshot rather than extending it.
  // Emit the snapshot once instead of guessing at an unsafe overlap.
  return full;
}

function beginClaudeMessage(
  ctx: AgentRunContext,
  state: ClaudeRunState,
  messageId: string | null,
  isSubagent: boolean,
): void {
  const effectiveMessageId = messageId ?? state.currentMessageId;
  const isNewMessage = state.currentMessageId !== null && effectiveMessageId !== state.currentMessageId;
  if (isNewMessage && (state.streamedThinking || state.streamedText)) {
    ctx.emitAgentEvent({ type: 'thinking-delta', text: '\n\n', streaming: true });
  }
  if (state.currentMessageId === null || isNewMessage) {
    state.currentMessageId = effectiveMessageId;
    state.currentIsSubagent = isSubagent;
    state.streamedThinking = '';
    state.streamedText = '';
    state.lastRenderedContentKind = null;
    state.startedToolIds.clear();
  }
}

function emitClaudeProgress(
  ctx: AgentRunContext,
  state: ClaudeRunState,
  kind: 'thinking' | 'text',
  text: string,
  streaming = false,
  label?: string,
): void {
  if (!text) return;
  if (state.lastRenderedContentKind && state.lastRenderedContentKind !== kind) {
    ctx.emitAgentEvent({ type: 'thinking-delta', text: '\n\n', streaming: true });
  }
  state.lastRenderedContentKind = kind;
  ctx.emitAgentEvent({ type: 'status', status: 'thinking', label });
  ctx.emitAgentEvent({
    type: 'thinking-delta',
    text,
    messageId: state.currentMessageId ?? undefined,
    streaming,
  });
}

function commitClaudeSession(ctx: AgentRunContext, state: ClaudeRunState): void {
  const sessionId = state.pendingSessionId;
  if (!sessionId || sessionId === ctx.getSessionId()) return;
  ctx.updateSessionId(sessionId);
  ctx.emitAgentEvent({ type: 'session', providerSessionId: sessionId });
}

function tokenCount(model: any): number {
  if (!model || typeof model !== 'object') return 0;
  return (Number(model.inputTokens) || 0)
    + (Number(model.outputTokens) || 0)
    + (Number(model.cacheReadInputTokens) || 0)
    + (Number(model.cacheCreationInputTokens) || 0);
}

/** Select only a real Claude model from result.modelUsage. Accounting-only
 * buckets such as `<synthetic>` are intentionally ignored. */
export function selectClaudeServingModel(modelUsage: unknown): { modelRan?: string; contextLimit?: number } {
  if (!modelUsage || typeof modelUsage !== 'object') return {};
  let modelRan: string | undefined;
  let contextLimit: number | undefined;
  let bestTokens = -1;
  for (const [id, model] of Object.entries(modelUsage as Record<string, any>)) {
    if (!isRealClaudeModelId(id)) continue;
    const tokens = tokenCount(model);
    if (tokens > bestTokens) {
      bestTokens = tokens;
      modelRan = id;
      contextLimit = typeof model?.contextWindow === 'number' ? model.contextWindow : undefined;
    }
  }
  return { modelRan, contextLimit };
}

export function resolveClaudeLaunchCommand(
  claudeBin: string,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
  nodeBin?: string,
): string[] {
  if (platform !== 'win32' || extname(claudeBin).toLowerCase() !== '.cmd') return [claudeBin];

  // Avoid cmd.exe for the standard npm shim. Besides its smaller command-line
  // limit, Bun/cmd can split an absolute shim path containing spaces. Invoking
  // Claude's JavaScript entry point directly keeps argv structured and avoids
  // shell interpretation of system-prompt characters.
  const entrypoint = win32Path.resolve(
    win32Path.dirname(claudeBin),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'cli.js',
  );
  return pathExists(entrypoint) ? [nodeBin || resolveCliBinary('node'), entrypoint] : [claudeBin];
}

export const claudeAdapter: AgentAdapter<ClaudeRunState> = {
  kind: 'claude',
  displayName: 'Claude',

  createState() {
    return createClaudeRunState();
  },

  createHandle(prompt: string, ctx: AgentRunContext, state: ClaudeRunState): AgentHandle {
    let proc: ReturnType<typeof safeSpawn> | null = null;
    let killed = false;
    let terminationPromise: Promise<void> | null = null;
    let terminationResult: ProcessTerminationResult | null = null;
    let terminationWarningEmitted = false;
    const unwind = createProcessUnwindSignal();

    const warnAndUnwind = (detail: string): void => {
      if (!terminationWarningEmitted) {
        terminationWarningEmitted = true;
        ctx.emitSystemMessage(
          `Claude process termination could not be confirmed (${detail}). ` +
          'Agent Forge stopped waiting for it and finalized this turn so the chat queue would not hang. ' +
          'Restart Agent Forge or use Kill All before starting more work in this project.',
        );
      }
      unwind.trigger();
    };

    const requestTermination = (): Promise<void> => {
      if (!proc) return Promise.resolve();
      if (terminationPromise) return terminationPromise;
      const target = proc;
      terminationPromise = killProcessTree(target).then(
        result => {
          terminationResult = result;
          if (!result.rootExited) warnAndUnwind('the process did not exit after bounded kill attempts');
          else unwind.trigger();
        },
        error => {
          try { target.unref(); } catch {}
          warnAndUnwind(error instanceof Error ? error.message : String(error));
        },
      );
      return terminationPromise;
    };

    const requestGracefulStop = async (): Promise<void> => {
      if (!proc) return;
      if (process.platform === 'win32') return requestTermination();
      const target = proc;
      try {
        target.kill('SIGINT');
      } catch {
        return requestTermination();
      }
      const gracefulExit = await waitForProcessExit(target, 1_000);
      if (gracefulExit.status !== 'exited' && proc === target) await requestTermination();
    };

    // Resolve to absolute path so Bun.spawn doesn't have to probe PATHEXT
    // from the agent's cwd (which fails on Windows for npm shim files).
    const claudeBin = resolveCliBinary('claude');
    const claudeCommand = resolveClaudeLaunchCommand(claudeBin);
    const args: string[] = [
      ...claudeCommand,
      '--print',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--forward-subagent-text',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    // Reference directories — pre-validated by the bridge (only existing paths land here).
    for (const dir of ctx.referencePaths ?? []) {
      if (existsSync(dir)) args.push('--add-dir', dir);
    }

    // Appended system prompt (guardrails + persona + project context + notes + docs + ...).
    // The bridge builds this via prompt-builder.service so the prompt itself is provider-agnostic.
    if (ctx.systemPrompt) {
      args.push('--append-system-prompt', ctx.systemPrompt);
    }

    if (ctx.model) {
      args.push('--model', ctx.model);
    }

    const sessionId = ctx.getSessionId();
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    return {
      async run() {
        try {
          // CLAUDECODE leaks "already inside Claude Code" signals. createCliEnv
          // strips it and augments PATH for GUI/editor-launched servers.
          const env = createCliEnv();
          const authError = await getClaudeAuthError(claudeCommand, env);
          if (authError) {
            ctx.emitAgentEvent({ type: 'error', message: authError });
            ctx.emitSystemMessage(authError);
            ctx.emitAgentEvent({ type: 'finish', reason: 'auth-error' });
            return undefined;
          }

          try {
            proc = safeSpawn(args, {
              cwd: ctx.cwd,
              stdin: 'pipe',
              stdout: 'pipe',
              stderr: 'pipe',
              env,
            });
          } catch (e: any) {
            if (e instanceof ArgvTooLongError) {
              ctx.emitAgentEvent({ type: 'error', message: e.message });
              ctx.emitSystemMessage(e.message);
              ctx.emitAgentEvent({ type: 'finish', reason: 'argv-too-long' });
              return undefined;
            }
            throw e;
          }

          if (proc.pid) persistenceService.trackPid(proc.pid);

          // A stop/kill may have landed between handle registration and the
          // spawn above — honor it now instead of running a full orphan turn.
          if (killed) {
            void requestTermination();
          }

          // Feed the prompt via stdin then close, so the CLI processes a single turn
          // and exits. This matches the agent-forge convention; --print + stdin is the
          // shape Claude CLI expects for non-interactive batch use.
          try {
            proc.stdin.write(prompt + '\n');
            proc.stdin.end();
          } catch (e) {
            // If stdin is broken the CLI would sit waiting for input forever —
            // kill it so the turn unwinds instead of wedging the agent.
            console.warn('[claude] stdin write failed; killing process:', e);
            void requestTermination();
          }

          // Capture stderr for the post-exit error surface. The chat bridge
          // suppresses these diagnostic chunks while the turn is running.
          const stderrPromise = (async () => {
            const reader = (proc!.stderr as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            let acc = '';
            try {
              while (true) {
                const next = await waitForOperationOrUnwind(reader.read(), unwind);
                if (next.status === 'unwound') break;
                const { done, value } = next.value;
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text) {
                  acc += text;
                  // Keep only the tail — a chatty/looping CLI can otherwise
                  // balloon memory and later broadcast a megabyte error blob.
                  if (acc.length > 64_000) acc = acc.slice(-64_000);
                  ctx.emitAgentEvent({ type: 'stderr', text });
                }
              }
            } catch {
              // stream closed
            } finally {
              if (unwind.isTriggered()) void reader.cancel().catch(() => {});
              try { reader.releaseLock(); } catch {}
            }
            return acc + decoder.decode();
          })();

          // Stream stdout NDJSON line-by-line.
          const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
          const decoder = new TextDecoder();
          let leftover = '';
          let lastResultText = '';

          const handleEvent = (event: any) => {
            try {
              normalizeClaudeEvent(event, ctx, state, (resultText: string) => { lastResultText = resultText; });
            } catch (e) {
              console.error('[claude] event handler threw:', e);
            }
            ctx.emitChatEvent(event);
          };

          try {
            while (true) {
              const next = await waitForOperationOrUnwind(reader.read(), unwind);
              if (next.status === 'unwound') break;
              const { done, value } = next.value;
              if (done) break;
              leftover += decoder.decode(value, { stream: true });
              leftover = parseNdjsonLines(leftover, handleEvent);
              // A single newline-free line growing without bound means the CLI
              // is emitting something we'll never parse — drop it rather than OOM.
              if (leftover.length > 10_000_000) {
                console.error('[claude] dropping >10MB unterminated stdout line');
                leftover = '';
              }
            }
            flushNdjsonLeftover(leftover, handleEvent);
          } finally {
            if (unwind.isTriggered()) void reader.cancel().catch(() => {});
            try { reader.releaseLock(); } catch {}
          }

          const exitOutcome = await waitForOperationOrUnwind(proc.exited, unwind);
          const rootExitConfirmed = exitOutcome.status === 'completed'
            || terminationResult?.rootExited === true;
          const exitCode = exitOutcome.status === 'completed'
            ? exitOutcome.value
            : terminationResult?.exitCode ?? -1;
          if (rootExitConfirmed && proc.pid) persistenceService.untrackPid(proc.pid);
          proc = null;

          const stderrText = (await stderrPromise).trim();
          if (!killed && exitCode !== 0 && /No conversation found with session ID/i.test(stderrText)) {
            ctx.emitAgentEvent({
              type: 'finish',
              reason: 'stale-session',
            });
            return {
              recoverableError: 'stale-session',
              errorMessage: stderrText,
            };
          }
          if (!killed && exitCode !== 0) {
            // Even with empty stderr the user must see that the turn failed —
            // otherwise a crash looks like "Claude said nothing".
            ctx.emitAgentEvent({
              type: 'error',
              message: stderrText || `Claude CLI exited with code ${exitCode} and no output`,
            });
          }

          ctx.emitAgentEvent({
            type: 'finish',
            reason: killed ? 'killed' : (exitCode === 0 ? 'completed' : `exit:${exitCode}`),
          });

          return lastResultText ? { lastAssistantMessage: lastResultText } : undefined;
        } catch (err: any) {
          const failedProc = proc;
          if (failedProc) {
            await requestTermination();
            if (terminationResult?.rootExited && failedProc.pid) {
              persistenceService.untrackPid(failedProc.pid);
            }
          }
          proc = null;
          const msg = err?.message || 'Claude encountered an unexpected error';
          ctx.emitAgentEvent({ type: 'error', message: msg });
          ctx.emitAgentEvent({ type: 'finish', reason: 'error' });
          return undefined;
        }
      },

      async stop() {
        // Set killed even before proc exists — run() checks it post-spawn so a
        // stop landing in the spawn window doesn't produce an orphan turn.
        killed = true;
        if (!proc) return;
        try {
          await requestGracefulStop();
        } catch (e) {
          console.warn('[claude] stop() failed:', e);
          warnAndUnwind(e instanceof Error ? e.message : String(e));
        }
      },

      async kill() {
        killed = true;
        if (!proc) return;
        try {
          await requestTermination();
        } catch (e) {
          console.warn('[claude] kill() failed:', e);
          warnAndUnwind(e instanceof Error ? e.message : String(e));
        }
      },
    };
  },
};

const CLAUDE_AUTH_CHECK_TIMEOUT_MS = 5_000;

async function getClaudeAuthError(claudeCommand: readonly string[], env: Record<string, string>): Promise<string | null> {
  if (env.AGENT_FORGE_SKIP_CLAUDE_AUTH_CHECK === '1') return null;

  // API-key/token environments do not need Claude Code's persisted first-party login.
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) {
    return null;
  }

  try {
    const result = await getClaudeAuthStatus(claudeCommand, env);
    if (!result) return null;

    const { status, detail } = result;

    if (status?.loggedIn === true) return null;
    if (status?.loggedIn !== false) return null;

    return [
      'Claude Code is not authenticated for non-interactive Agent Forge runs.',
      `Fresh CLI auth check failed (${detail}).`,
      'Run `claude auth login` in a normal terminal, then verify `claude auth status` reports loggedIn=true.',
      'If you use a Claude subscription token instead, run `claude setup-token`; if you use the Anthropic API, start Agent Forge with `ANTHROPIC_API_KEY` set.',
    ].join('\n');
  } catch (e: any) {
    console.warn('[claude] auth status check skipped:', e?.message || e);
    return null;
  }
}

async function getClaudeAuthStatus(
  claudeCommand: readonly string[],
  env: Record<string, string>,
): Promise<{ status: any; detail: string } | null> {
  const proc = Bun.spawn([...claudeCommand, 'auth', 'status'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const result = await collectBoundedProcess(proc, {
    timeoutMs: CLAUDE_AUTH_CHECK_TIMEOUT_MS,
    terminationTimeoutMs: 2_000,
    maxChars: 64_000,
    retainOutput: 'head',
    label: 'Claude auth status check',
    terminate: () => killProcessTree(proc),
  });
  if (result.timedOut || result.error) {
    console.warn(`[claude] ${result.error || `auth status check timed out after ${CLAUDE_AUTH_CHECK_TIMEOUT_MS}ms`}`);
    return null;
  }

  const stdout = result.stdout;
  try {
    let status: any = null;
    try {
      status = stdout ? JSON.parse(stdout) : null;
    } catch {
      console.warn('[claude] auth status returned non-JSON output');
      return null;
    }

    if (!status || typeof status !== 'object') return null;

    return {
      status,
      detail: `status=${JSON.stringify({
        loggedIn: status.loggedIn,
        authMethod: status.authMethod,
        apiProvider: status.apiProvider,
      })}`,
    };
  } catch {
    return null;
  }
}

/**
 * Translate a single Claude stream-json event into one or more normalized
 * AgentEvent emissions. The captureResult callback lets run() store the final
 * result text for the AgentRunResult return.
 */
export function normalizeClaudeEvent(
  event: any,
  ctx: AgentRunContext,
  state: ClaudeRunState,
  captureResult: (text: string) => void,
): void {
  if (!event || typeof event !== 'object' || !event.type) return;

  // system/init: emits the session_id we need to resume next turn.
  if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
    // Defer claiming a fresh session until a real assistant/result event. A
    // local validation-only run can emit init metadata followed by a synthetic
    // error; claiming it would corrupt resume ownership despite no model call.
    state.pendingSessionId = event.session_id;
    return;
  }

  // With --include-partial-messages Claude forwards the Anthropic streaming
  // events under stream_event.event. These are the live token source; the
  // later assistant snapshot is retained only as a gap-filling fallback.
  if (event.type === 'stream_event' && event.event && typeof event.event === 'object') {
    const streamEvent = event.event;
    if (streamEvent.type === 'message_start') {
      beginClaudeMessage(
        ctx,
        state,
        typeof streamEvent.message?.id === 'string' ? streamEvent.message.id : null,
        typeof event.parent_tool_use_id === 'string' && !!event.parent_tool_use_id,
      );
      return;
    }
    if (streamEvent.type === 'content_block_start' && streamEvent.content_block?.type === 'tool_use') {
      const block = streamEvent.content_block;
      const toolName = String(block.name ?? 'tool');
      // The start frame does not yet contain the streamed JSON input. Mark the
      // phase now, then let the completed assistant block emit the tool event
      // with its full input so plan-write detection and activity summaries keep
      // working.
      ctx.emitAgentEvent({ type: 'status', status: 'tool', label: `Using ${toolName}` });
      return;
    }
    if (streamEvent.type === 'content_block_delta') {
      const delta = streamEvent.delta;
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
        state.streamedThinking += delta.thinking;
        emitClaudeProgress(ctx, state, 'thinking', delta.thinking, true);
        return;
      }
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        state.streamedText += delta.text;
        emitClaudeProgress(
          ctx,
          state,
          'text',
          delta.text,
          true,
          state.currentIsSubagent ? 'Subagent working' : 'Claude working',
        );
        return;
      }
    }
    return;
  }

  // assistant: contains usage stats + content blocks (text / thinking / tool_use).
  if (event.type === 'assistant') {
    // Every assistant message carries the model that produced it — ground
    // truth per API call, available even when the turn dies before the final
    // result event (kill, crash, max-turns). The result-event modelUsage
    // check below stays as the authoritative end-of-turn snapshot.
    const assistantMessageId = typeof event.message?.id === 'string' ? event.message.id : null;
    const isSubagent = typeof event.parent_tool_use_id === 'string' && !!event.parent_tool_use_id;
    beginClaudeMessage(ctx, state, assistantMessageId, isSubagent);
    const messageModel = event.message?.model;
    const realMessageModel = !isSubagent && isRealClaudeModelId(messageModel) ? messageModel : undefined;
    if (realMessageModel) commitClaudeSession(ctx, state);
    const usage = event.message?.usage;
    if (usage && typeof usage === 'object') {
      const inputTokens = (usage.input_tokens || 0)
        + (usage.cache_creation_input_tokens || 0)
        + (usage.cache_read_input_tokens || 0);
      ctx.emitAgentEvent({
        type: 'usage',
        contextTokens: inputTokens > 0 ? inputTokens : undefined,
        inputTokensDelta: inputTokens > 0 ? inputTokens : undefined,
        outputTokensDelta: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
        modelRan: realMessageModel,
      });
    } else if (realMessageModel) {
      ctx.emitAgentEvent({ type: 'usage', modelRan: realMessageModel });
    }

    const content = event.message?.content;
    if (Array.isArray(content)) {
      const completeThinking = content
        .filter((block: any) => block?.type === 'thinking' && typeof block.thinking === 'string')
        .map((block: any) => block.thinking)
        .join('');
      const completeText = content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('');
      const thinkingSuffix = snapshotSuffix(completeThinking, state.streamedThinking);
      const textSuffix = snapshotSuffix(completeText, state.streamedText);
      if (completeThinking) state.streamedThinking = completeThinking;
      if (completeText) state.streamedText = completeText;
      if (thinkingSuffix) {
        emitClaudeProgress(ctx, state, 'thinking', thinkingSuffix);
      }
      if (textSuffix) {
        emitClaudeProgress(
          ctx,
          state,
          'text',
          textSuffix,
          false,
          isSubagent ? 'Subagent working' : 'Claude working',
        );
      }
      if (!isSubagent && completeText) {
        ctx.emitAgentEvent({ type: 'assistant-snapshot', text: completeText });
      }

      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (!block || typeof block !== 'object') continue;

        if (block.type === 'thinking' || block.type === 'text') continue;
        if (block.type === 'tool_use') {
          const toolName = String(block.name ?? 'tool');
          const input = block.input ?? {};
          const toolCallId = String(block.id ?? `${toolName}:${i}`);
          if (!state.startedToolIds.has(toolCallId)) {
            state.startedToolIds.add(toolCallId);
            ctx.emitAgentEvent({
              type: 'tool-call-start',
              toolCallId,
              toolName,
              input,
              summary: summarizeToolInput(toolName, input),
            });
          }
          continue;
        }
      }
    }
    return;
  }

  // user: contains tool_result blocks (one per finished tool call).
  if (event.type === 'user') {
    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_result') {
          ctx.emitAgentEvent({
            type: 'tool-call-end',
            toolCallId: String(block.tool_use_id ?? 'unknown'),
            output: block.content,
            error: block.is_error ? 'tool reported error' : undefined,
          });
        }
      }
    }
    return;
  }

  // result: final cost + turn count + (sometimes) a fallback result text + modelUsage.
  if (event.type === 'result') {
    const resultText = typeof event.result === 'string' ? event.result : '';
    const localValidationFailure = /Goal condition is limited to \d+ characters \(got \d+\)/i.test(resultText);
    const resultIsError = event.is_error === true || event.subtype === 'error_during_execution' || localValidationFailure;
    if (resultText && resultIsError) {
      ctx.emitAgentEvent({ type: 'error', message: resultText });
      if (localValidationFailure) return;
    } else if (resultText) {
      captureResult(event.result);
      ctx.emitAgentEvent({ type: 'result', text: event.result });
    }

    commitClaudeSession(ctx, state);

    const { contextLimit, modelRan } = selectClaudeServingModel(event.modelUsage);

    // Silent-substitution guard: if the model that actually ran differs from what
    // the user requested, the service quietly served something else. Confirmed
    // 2026-07-01: large-context claude-fable-5 requests are served by
    // claude-opus-4-8[1m]; phantom ids (claude-sonnet-5) get downgraded too.
    // chat.service latches this same comparison into agent.modelMismatch, which
    // BLOCKS further sends until the user resolves it — this message is the
    // in-conversation explanation of why.
    if (modelRan && ctx.model && stripModelTier(modelRan) !== stripModelTier(ctx.model)) {
      ctx.emitSystemMessage(
        `⚠ Requested model "${ctx.model}" but the CLI actually ran "${modelRan}". ` +
        `The service substituted it silently (this happens when the id isn't available ` +
        `on this account, or when a large-context Fable request is served by Opus). ` +
        `This agent is now blocked until you resolve the mismatch banner.`,
      );
    }

    ctx.emitAgentEvent({
      type: 'usage',
      contextLimit,
      modelRan,
      costUsdDelta: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
      turnsDelta: typeof event.num_turns === 'number' ? event.num_turns : undefined,
    });
    return;
  }

  // error event (rare — most failures arrive on stderr).
  if (event.type === 'error' && typeof event.message === 'string') {
    ctx.emitAgentEvent({ type: 'error', message: event.message });
    return;
  }
}

// Re-export so the registry import resolves cleanly.
export { drainStreamToString };
