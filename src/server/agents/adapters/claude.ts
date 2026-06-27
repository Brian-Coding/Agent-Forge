import { existsSync } from 'fs';
import { ArgvTooLongError, createCliEnv, resolveCliBinary, safeSpawn } from '../../utils';
import { persistenceService } from '../../services/persistence.service';
import { summarizeToolInput, type AgentEvent } from '../events';
import { drainStreamToString, parseNdjsonLines, flushNdjsonLeftover } from '../stream-utils';
import type { AgentAdapter, AgentHandle, AgentRunContext } from '../types';

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
 *                    type=text     → emit 'status:responding' + 'text-delta'
 *                    type=tool_use → emit 'tool-call-start'
 *   user         → per content block: type=tool_result → emit 'tool-call-end'
 *   result       → emit 'usage' (cost+turns deltas, contextLimit snapshot) + 'result'
 *   stderr       → emit 'stderr' chunks live
 *   exit         → emit 'finish'
 *
 * The bridge (chat.service) accumulates usage deltas onto the agent's
 * running totals and broadcasts `token_usage` with the snapshot.
 */
export const claudeAdapter: AgentAdapter<undefined> = {
  kind: 'claude',
  displayName: 'Claude',

  createState() {
    return undefined;
  },

  createHandle(prompt: string, ctx: AgentRunContext): AgentHandle {
    let proc: ReturnType<typeof safeSpawn> | null = null;
    let killed = false;

    // Resolve to absolute path so Bun.spawn doesn't have to probe PATHEXT
    // from the agent's cwd (which fails on Windows for npm shim files).
    const claudeBin = resolveCliBinary('claude');
    const args: string[] = [
      claudeBin,
      '--print',
      '--output-format', 'stream-json',
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
          const authError = await getClaudeAuthError(claudeBin, env);
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

          // Feed the prompt via stdin then close, so the CLI processes a single turn
          // and exits. This matches the agent-forge convention; --print + stdin is the
          // shape Claude CLI expects for non-interactive batch use.
          try {
            proc.stdin.write(prompt + '\n');
            proc.stdin.end();
          } catch (e) {
            console.warn('[claude] stdin write failed:', e);
          }

          // Stream stderr live so the UI can show error output as it arrives.
          // Also captures a final string for the post-exit error surface.
          const stderrPromise = (async () => {
            const reader = (proc!.stderr as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            let acc = '';
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value, { stream: true });
                if (text) {
                  acc += text;
                  ctx.emitAgentEvent({ type: 'stderr', text });
                }
              }
            } catch {
              // stream closed
            } finally {
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
              normalizeClaudeEvent(event, ctx, (resultText: string) => { lastResultText = resultText; });
            } catch (e) {
              console.error('[claude] event handler threw:', e);
            }
            ctx.emitChatEvent(event);
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              leftover += decoder.decode(value, { stream: true });
              leftover = parseNdjsonLines(leftover, handleEvent);
            }
            flushNdjsonLeftover(leftover, handleEvent);
          } finally {
            try { reader.releaseLock(); } catch {}
          }

          const exitCode = await proc.exited;
          if (proc.pid) persistenceService.untrackPid(proc.pid);
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
          if (!killed && exitCode !== 0 && stderrText) {
            ctx.emitAgentEvent({ type: 'error', message: stderrText });
          }

          ctx.emitAgentEvent({
            type: 'finish',
            reason: killed ? 'killed' : (exitCode === 0 ? 'completed' : `exit:${exitCode}`),
          });

          return lastResultText ? { lastAssistantMessage: lastResultText } : undefined;
        } catch (err: any) {
          if (proc?.pid) persistenceService.untrackPid(proc.pid);
          proc = null;
          const msg = err?.message || 'Claude encountered an unexpected error';
          ctx.emitAgentEvent({ type: 'error', message: msg });
          ctx.emitAgentEvent({ type: 'finish', reason: 'error' });
          return undefined;
        }
      },

      stop() {
        if (!proc) return;
        try {
          // SIGINT lets the CLI flush + exit gracefully. If it ignores us, the
          // event loop will still resolve when the kernel reaps it. We do NOT
          // escalate to SIGKILL here — that's what kill() is for.
          killed = true;
          proc.kill('SIGINT');
        } catch (e) {
          console.warn('[claude] stop() failed:', e);
        }
      },

      kill() {
        if (!proc) return;
        try {
          killed = true;
          proc.kill();
        } catch (e) {
          console.warn('[claude] kill() failed:', e);
        }
      },
    };
  },
};

const CLAUDE_AUTH_CHECK_TIMEOUT_MS = 5_000;

async function getClaudeAuthError(claudeBin: string, env: Record<string, string>): Promise<string | null> {
  if (env.AGENT_FORGE_SKIP_CLAUDE_AUTH_CHECK === '1') return null;

  // API-key/token environments do not need Claude Code's persisted first-party login.
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN) {
    return null;
  }

  try {
    const result = await getClaudeAuthStatus(claudeBin, env);
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
  claudeBin: string,
  env: Record<string, string>,
): Promise<{ status: any; detail: string } | null> {
  let timedOut = false;
  const proc = Bun.spawn([claudeBin, 'auth', 'status'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, CLAUDE_AUTH_CHECK_TIMEOUT_MS);

  try {
    const [, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    if (timedOut) {
      console.warn(`[claude] auth status check timed out after ${CLAUDE_AUTH_CHECK_TIMEOUT_MS}ms`);
      return null;
    }

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
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Translate a single Claude stream-json event into one or more normalized
 * AgentEvent emissions. The captureResult callback lets run() store the final
 * result text for the AgentRunResult return.
 */
function normalizeClaudeEvent(
  event: any,
  ctx: AgentRunContext,
  captureResult: (text: string) => void,
): void {
  if (!event || typeof event !== 'object' || !event.type) return;

  // system/init: emits the session_id we need to resume next turn.
  if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
    const prev = ctx.getSessionId();
    if (event.session_id !== prev) {
      ctx.updateSessionId(event.session_id);
      ctx.emitAgentEvent({ type: 'session', providerSessionId: event.session_id });
    }
    return;
  }

  // assistant: contains usage stats + content blocks (text / thinking / tool_use).
  if (event.type === 'assistant') {
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
      });
    }

    const content = event.message?.content;
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (!block || typeof block !== 'object') continue;

        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          ctx.emitAgentEvent({ type: 'status', status: 'thinking' });
          ctx.emitAgentEvent({ type: 'thinking-delta', text: block.thinking });
          continue;
        }
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          ctx.emitAgentEvent({ type: 'status', status: 'responding' });
          ctx.emitAgentEvent({ type: 'text-delta', text: block.text });
          continue;
        }
        if (block.type === 'tool_use') {
          const toolName = String(block.name ?? 'tool');
          const input = block.input ?? {};
          const toolCallId = String(block.id ?? `${toolName}:${i}`);
          ctx.emitAgentEvent({
            type: 'tool-call-start',
            toolCallId,
            toolName,
            input,
            summary: summarizeToolInput(toolName, input),
          });
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
    if (typeof event.result === 'string' && event.result) {
      captureResult(event.result);
      ctx.emitAgentEvent({ type: 'result', text: event.result });
    }

    let contextLimit: number | undefined;
    if (event.modelUsage && typeof event.modelUsage === 'object') {
      for (const model of Object.values(event.modelUsage) as any[]) {
        if (model && typeof model.contextWindow === 'number') {
          contextLimit = model.contextWindow;
          break;
        }
      }
    }

    ctx.emitAgentEvent({
      type: 'usage',
      contextLimit,
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
