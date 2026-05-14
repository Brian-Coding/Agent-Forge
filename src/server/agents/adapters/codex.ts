import { existsSync, readFileSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { ArgvTooLongError, safeSpawn } from '../../utils';
import { persistenceService } from '../../services/persistence.service';
import { summarizeToolInput, type AgentEvent } from '../events';
import { drainStreamToString, parseNdjsonLines, flushNdjsonLeftover } from '../stream-utils';
import type { AgentAdapter, AgentHandle, AgentRunContext } from '../types';

/**
 * Codex CLI adapter. Wraps:
 *   codex exec [--json] [--skip-git-repo-check]
 *              [--output-last-message <tmpfile>]
 *              [--dangerously-bypass-approvals-and-sandbox]
 *              [-m <model>] [-c reasoning_effort=<level>] [-C <cwd>]
 *              [resume <session_id>] -
 *   (prompt piped via stdin since `-` is supplied)
 *
 * Codex's native event stream differs from Claude's stream-json — it's
 * organized around "items" (command_execution, file_change, agent_message)
 * with started/updated/completed transitions, plus separate begin/end
 * events for exec / patch / web_search / mcp tool calls.
 *
 * Codex can print a known non-fatal "failed to record rollout items"
 * diagnostic on stderr; it is filtered out.
 *
 * The agent-forge system prompt (guardrails + persona + notes + docs + atlas
 * citation) is prepended to the user prompt with delimiter markers since
 * Codex has no `--append-system-prompt` flag equivalent.
 */

interface CodexRunState {
  outputPath: string;
  // Streaming state machine — Codex sends discrete items; we treat them like
  // assistant/tool blocks for parity with Claude's content_block semantics.
  assistantOpen: boolean;
  toolOpen: boolean;
  sawAssistantStream: boolean;
  hasFinalAssistantMessage: boolean;
  lastAssistantMessage: string;
  currentToolId: string | null;
  // file_change events don't include diffs — capture before/after snapshots
  // so we can synthesize Edit tool events.
  fileSnapshots: Map<string, string | null>;
  // exec_command_output_delta repeats the full aggregated output each time;
  // track what we've already shown so we can emit just the delta.
  commandOutputs: Map<string, string>;
}

const MAX_INLINE_DIFF_CHARS = 80_000;

// stderr lines containing this phrase are dropped (harmless noise on every run).
const STDERR_NOISE_PATTERNS = [
  /failed to record rollout items/i,
];

function extractText(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.message === 'string') return value.message;
  if (typeof value.content === 'string') return value.content;
  if (typeof value.delta === 'string') return value.delta;
  if (typeof value.last_agent_message === 'string') return value.last_agent_message;
  if (typeof value.output_text === 'string') return value.output_text;
  if (Array.isArray(value.content)) {
    return value.content.map((item: any) => extractText(item)).filter(Boolean).join('');
  }
  return '';
}

function safePaneFileStem(paneId: string): string {
  return paneId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'pane';
}

function isWithinDirectory(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

function resolveChangedPath(cwd: string, value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const absolutePath = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  return isWithinDirectory(absolutePath, cwd) || absolutePath === cwd ? absolutePath : null;
}

function getDisplayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : absolutePath;
}

function readSnapshot(path: string): string | null {
  try {
    if (!existsSync(path)) return '';
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_INLINE_DIFF_CHARS) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function getFileChangePaths(cwd: string, item: any): string[] {
  const changes: any[] = Array.isArray(item?.changes) ? item.changes : [];
  const paths: string[] = changes
    .map((c: any) => resolveChangedPath(cwd, c?.path ?? c?.file_path ?? c?.file))
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (paths.length > 0) return Array.from(new Set(paths));
  const single = resolveChangedPath(cwd, item?.path ?? item?.file_path ?? item?.file);
  return single ? [single] : [];
}

/**
 * Translate a single Codex JSONL event into AgentEvent emissions on ctx.
 * Codex's event vocabulary is richer than Claude's — see handler chain below
 * for the complete dispatch.
 */
function handleCodexEvent(ctx: AgentRunContext, state: CodexRunState, event: any): void {
  if (!event || typeof event !== 'object') return;

  const startAssistant = () => {
    if (state.assistantOpen) return;
    closeTool();
    state.assistantOpen = true;
    state.sawAssistantStream = true;
  };
  const closeAssistant = () => { state.assistantOpen = false; };
  const startTool = (name: string, input: unknown = {}) => {
    closeAssistant();
    closeTool();
    const toolCallId = `${name}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    ctx.emitAgentEvent({
      type: 'tool-call-start',
      toolCallId,
      toolName: name,
      input,
      summary: summarizeToolInput(name, input),
    });
    state.toolOpen = true;
    state.currentToolId = toolCallId;
  };
  const closeTool = () => {
    if (!state.toolOpen) return;
    if (state.currentToolId) {
      ctx.emitAgentEvent({ type: 'tool-call-end', toolCallId: state.currentToolId });
    }
    state.toolOpen = false;
    state.currentToolId = null;
  };
  const toolDelta = (delta: string) => {
    if (!state.toolOpen || !delta || !state.currentToolId) return;
    ctx.emitAgentEvent({ type: 'tool-call-delta', toolCallId: state.currentToolId, delta });
  };
  const assistantDelta = (text: string) => {
    if (!text) return;
    startAssistant();
    ctx.emitAgentEvent({ type: 'text-delta', text });
  };
  const emitEditDiff = (absolutePath: string, before: string, after: string) => {
    if (before === after) return;
    if (before.length + after.length > MAX_INLINE_DIFF_CHARS) return;
    const input = {
      file_path: getDisplayPath(ctx.cwd, absolutePath),
      old_string: before,
      new_string: after,
    };
    startTool('Edit', input);
    closeTool();
  };
  const emitCommandOutputDelta = (item: any) => {
    if (typeof item?.aggregated_output !== 'string' || !item.aggregated_output) return;
    const itemId = typeof item.id === 'string' ? item.id : 'latest';
    const previous = state.commandOutputs.get(itemId) ?? '';
    const next = item.aggregated_output;
    const delta = next.startsWith(previous) ? next.slice(previous.length) : next;
    if (delta) toolDelta(delta);
    state.commandOutputs.set(itemId, next);
  };

  const item = event.item;

  // --- Session lifecycle -----------------------------------------------------
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    if (event.thread_id !== ctx.getSessionId()) {
      ctx.updateSessionId(event.thread_id);
      ctx.emitAgentEvent({ type: 'session', providerSessionId: event.thread_id });
    }
    return;
  }

  if (event.type === 'turn.started') {
    ctx.emitAgentEvent({ type: 'status', status: 'thinking' });
    return;
  }

  // Codex 0.125+ emits per-turn usage on turn.completed.
  // Shape: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }.
  // We treat the API's input_tokens as the snapshot ("how full is your context?")
  // and accumulate both regular + reasoning output as the spend per turn.
  if (event.type === 'turn.completed') {
    const usage = event.usage;
    if (usage && typeof usage === 'object') {
      const inputTokens = (typeof usage.input_tokens === 'number' ? usage.input_tokens : 0)
        + (typeof usage.cached_input_tokens === 'number' ? usage.cached_input_tokens : 0);
      const outputTokens = (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0)
        + (typeof usage.reasoning_output_tokens === 'number' ? usage.reasoning_output_tokens : 0);
      ctx.emitAgentEvent({
        type: 'usage',
        contextTokens: inputTokens > 0 ? inputTokens : undefined,
        inputTokensDelta: inputTokens > 0 ? inputTokens : undefined,
        outputTokensDelta: outputTokens > 0 ? outputTokens : undefined,
        turnsDelta: 1,
      });
    }
    return;
  }

  // --- Item: command_execution ----------------------------------------------
  if (event.type === 'item.started' && item?.type === 'command_execution') {
    const payload = { command: item.command ?? '', cwd: ctx.cwd };
    if (typeof item.id === 'string') {
      state.commandOutputs.set(item.id, item.aggregated_output ?? '');
    }
    startTool('exec', payload);
    return;
  }
  if (event.type === 'item.updated' && item?.type === 'command_execution') {
    emitCommandOutputDelta(item);
    return;
  }
  if (event.type === 'item.completed' && item?.type === 'command_execution') {
    emitCommandOutputDelta(item);
    if (typeof item.id === 'string') state.commandOutputs.delete(item.id);
    closeTool();
    return;
  }

  // --- Item: file_change -----------------------------------------------------
  if (event.type === 'item.started' && item?.type === 'file_change') {
    const paths = getFileChangePaths(ctx.cwd, item);
    for (const p of paths) state.fileSnapshots.set(p, readSnapshot(p));
    startTool('patch', { changes: item.changes ?? paths });
    return;
  }
  if (event.type === 'item.completed' && item?.type === 'file_change') {
    const paths = getFileChangePaths(ctx.cwd, item);
    closeTool();
    // Synthesize one Edit tool event per actually-changed file with the
    // before/after diff inlined. The bridge's .plans/ sniff picks these up
    // for live-document sync, so writes to .plans/*.md still flow through.
    for (const p of paths) {
      const before = state.fileSnapshots.get(p);
      const after = readSnapshot(p);
      state.fileSnapshots.delete(p);
      if (before !== null && before !== undefined && after !== null) {
        emitEditDiff(p, before, after);
      }
    }
    return;
  }

  // --- Item: agent_message --------------------------------------------------
  if (event.type === 'item.completed' && item?.type === 'agent_message') {
    const text = typeof item.text === 'string' ? item.text : extractText(item);
    if (text) {
      assistantDelta(text);
      closeAssistant();
      state.lastAssistantMessage = text;
      state.hasFinalAssistantMessage = true;
    }
    return;
  }

  // --- Streamed assistant tokens --------------------------------------------
  if (event.type === 'agent_message_delta') {
    const delta = event.delta ?? event.text ?? event.content ?? '';
    if (typeof delta === 'string') assistantDelta(delta);
    ctx.emitAgentEvent({ type: 'status', status: 'responding' });
    return;
  }
  if (event.type === 'agent_message') {
    const content = event.message ?? event.content ?? event.text ?? '';
    if (typeof content === 'string' && content) assistantDelta(content);
    return;
  }

  // --- Older-style tool events (some Codex versions emit these) -------------
  if (event.type === 'exec_command_begin') {
    startTool('exec', {
      command: event.parsed_cmd ?? event.command ?? event.cmd ?? '',
      cwd: event.cwd ?? ctx.cwd,
    });
    return;
  }
  if (event.type === 'exec_command_output_delta') {
    const chunk = typeof event.chunk === 'string'
      ? Buffer.from(event.chunk, 'base64').toString('utf8')
      : '';
    toolDelta(chunk);
    return;
  }
  if (event.type === 'exec_command_end') {
    closeTool();
    return;
  }
  if (event.type === 'patch_apply_begin') {
    startTool('patch', { changes: event.changes ?? event.files ?? [] });
    return;
  }
  if (event.type === 'patch_apply_end') {
    closeTool();
    return;
  }
  if (event.type === 'web_search_begin') {
    startTool('WebSearch', { query: event.query ?? '' });
    return;
  }
  if (event.type === 'web_search_end') {
    if (event.query) toolDelta(String(event.query));
    closeTool();
    return;
  }
  if (event.type === 'mcp_tool_call_begin') {
    const toolName = event.invocation?.tool ?? event.tool ?? 'mcp_tool';
    const payload = event.invocation?.arguments ?? event.arguments ?? {};
    startTool(toolName, payload);
    return;
  }
  if (event.type === 'mcp_tool_call_end') {
    closeTool();
    return;
  }

  // --- Errors ---------------------------------------------------------------
  if (event.type === 'item.completed' && item?.type === 'error' && item.message) {
    ctx.emitAgentEvent({ type: 'error', message: String(item.message) });
    return;
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    ctx.emitAgentEvent({ type: 'error', message: event.message });
    return;
  }

  // --- Task complete: final assistant text fallback -------------------------
  if (event.type === 'task_complete' && typeof event.last_agent_message === 'string' && event.last_agent_message) {
    if (!state.sawAssistantStream) {
      ctx.emitAgentEvent({ type: 'result', text: event.last_agent_message });
      state.hasFinalAssistantMessage = true;
      state.lastAssistantMessage = event.last_agent_message;
    }
    return;
  }
}

// --- Adapter ----------------------------------------------------------------

export const codexAdapter: AgentAdapter<CodexRunState> = {
  kind: 'codex',
  displayName: 'Codex',

  createState(ctx) {
    const stem = safePaneFileStem(ctx.paneId);
    return {
      outputPath: resolve(tmpdir(), `agent-forge-codex-${stem}-${Date.now()}.txt`),
      assistantOpen: false,
      toolOpen: false,
      sawAssistantStream: false,
      hasFinalAssistantMessage: false,
      lastAssistantMessage: '',
      currentToolId: null,
      fileSnapshots: new Map(),
      commandOutputs: new Map(),
    };
  },

  createHandle(prompt: string, ctx: AgentRunContext, state: CodexRunState): AgentHandle {
    let proc: ReturnType<typeof safeSpawn> | null = null;
    let killed = false;

    // Build args. The actual prompt is fed via stdin (`-`), so the system
    // prompt + user prompt content never hits argv (no 28K cap pressure).
    const baseArgs: string[] = [
      '--json',
      '--skip-git-repo-check',
      '--output-last-message', state.outputPath,
      '--dangerously-bypass-approvals-and-sandbox',
    ];
    if (ctx.model) {
      baseArgs.push('-m', ctx.model);
    }
    if (ctx.reasoningLevel) {
      // Older settings may store "extra_high" for the "xhigh" effort level; we
      // accept either spelling but normalize to the CLI form.
      const effort = ctx.reasoningLevel === 'extra_high' ? 'xhigh' : ctx.reasoningLevel;
      baseArgs.push('-c', `reasoning_effort="${effort}"`);
    }

    const sessionId = ctx.getSessionId();
    const args: string[] = sessionId
      ? ['codex', 'exec', 'resume', ...baseArgs, sessionId, '-']
      : ['codex', 'exec', ...baseArgs, '-'];

    // The Codex CLI doesn't have an --append-system-prompt flag. We
    // prepend the agent-forge system prompt (guardrails + persona + notes
    // + docs + atlas citation) to the user message with clear markers so
    // the model can distinguish system context from the user's actual turn.
    const fullPrompt = ctx.systemPrompt
      ? `=== SYSTEM CONTEXT (provided by agent-forge — these instructions are load-bearing) ===\n${ctx.systemPrompt}\n=== END SYSTEM CONTEXT ===\n\n=== USER MESSAGE ===\n${prompt}`
      : prompt;

    return {
      async run() {
        try {
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(process.env)) {
            if (k === 'CLAUDECODE') continue;
            if (typeof v === 'string') env[k] = v;
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

          // Pipe the (system + user) prompt via stdin.
          try {
            proc.stdin.write(fullPrompt);
            proc.stdin.end();
          } catch (e) {
            console.warn('[codex] stdin write failed:', e);
          }

          // Drain stderr — filter known harmless noise; surface anything else as live stderr events.
          const stderrPromise = (async () => {
            const reader = (proc!.stderr as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            let acc = '';
            let pendingLine = '';
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                if (!chunk) continue;
                acc += chunk;
                pendingLine += chunk;
                // Process complete lines for noise filtering; emit only what survives.
                let nlIdx: number;
                while ((nlIdx = pendingLine.indexOf('\n')) >= 0) {
                  const line = pendingLine.slice(0, nlIdx + 1);
                  pendingLine = pendingLine.slice(nlIdx + 1);
                  if (!STDERR_NOISE_PATTERNS.some(re => re.test(line))) {
                    ctx.emitAgentEvent({ type: 'stderr', text: line });
                  }
                }
              }
              if (pendingLine && !STDERR_NOISE_PATTERNS.some(re => re.test(pendingLine))) {
                ctx.emitAgentEvent({ type: 'stderr', text: pendingLine });
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

          const onEvent = (event: any) => {
            try {
              handleCodexEvent(ctx, state, event);
            } catch (e) {
              console.error('[codex] event handler threw:', e);
            }
            ctx.emitChatEvent(event);
          };

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              leftover += decoder.decode(value, { stream: true });
              leftover = parseNdjsonLines(leftover, onEvent);
            }
            flushNdjsonLeftover(leftover, onEvent);
          } finally {
            try { reader.releaseLock(); } catch {}
          }

          const exitCode = await proc.exited;
          if (proc.pid) persistenceService.untrackPid(proc.pid);
          proc = null;

          const stderrText = (await stderrPromise).trim();

          // Close any dangling block on truncation.
          if (state.toolOpen && state.currentToolId) {
            ctx.emitAgentEvent({ type: 'tool-call-end', toolCallId: state.currentToolId });
            state.toolOpen = false;
            state.currentToolId = null;
          }
          state.assistantOpen = false;

          // Read final assistant text from --output-last-message tmpfile.
          // Codex 0.125+ writes the canonical final answer here even when
          // the stream-event for item.completed/agent_message also ran.
          let finalText = '';
          try {
            const f = Bun.file(state.outputPath);
            if (await f.exists()) {
              finalText = (await f.text()).trim();
              if (finalText) state.lastAssistantMessage = finalText;
            }
          } finally {
            await unlink(state.outputPath).catch(() => {});
          }

          if (finalText && !state.sawAssistantStream && !state.hasFinalAssistantMessage) {
            ctx.emitAgentEvent({ type: 'result', text: finalText });
          } else if (!killed && exitCode !== 0 && stderrText) {
            // Stderr noise was filtered live; anything still here is real.
            ctx.emitAgentEvent({ type: 'error', message: stderrText });
          }

          ctx.emitAgentEvent({
            type: 'finish',
            reason: killed ? 'killed' : (exitCode === 0 ? 'completed' : `exit:${exitCode}`),
          });

          return state.lastAssistantMessage ? { lastAssistantMessage: state.lastAssistantMessage } : undefined;
        } catch (err: any) {
          if (proc?.pid) persistenceService.untrackPid(proc.pid);
          proc = null;
          const msg = err?.message || 'Codex encountered an unexpected error';
          ctx.emitAgentEvent({ type: 'error', message: msg });
          ctx.emitAgentEvent({ type: 'finish', reason: 'error' });
          return undefined;
        }
      },

      stop() {
        if (!proc) return;
        try {
          killed = true;
          proc.kill('SIGINT');
        } catch (e) {
          console.warn('[codex] stop() failed:', e);
        }
      },

      kill() {
        if (!proc) return;
        try {
          killed = true;
          proc.kill();
        } catch (e) {
          console.warn('[codex] kill() failed:', e);
        }
      },
    };
  },
};

// Re-export so the registry import resolves cleanly when both adapters bundle.
export { drainStreamToString };
