import { existsSync, readFileSync, statSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, win32 as win32Path } from 'node:path';
import { ArgvTooLongError, createCliEnv, killProcessTree, resolveCliBinary, safeSpawn } from '../../utils';
import { persistenceService } from '../../services/persistence.service';
import { summarizeToolInput, type AgentEvent } from '../events';
import { drainStreamToString, parseNdjsonLines, flushNdjsonLeftover } from '../stream-utils';
import type { AgentAdapter, AgentHandle, AgentRunContext } from '../types';

/**
 * Codex CLI adapter. Wraps:
 *   codex exec [--json] [--skip-git-repo-check]
 *              [--output-last-message <tmpfile>]
 *              [--dangerously-bypass-approvals-and-sandbox]
 *              [--image <path>]...
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
  toolOpen: boolean;
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

export function codexReasoningConfigArg(level?: string): string {
  const normalized = level === 'extra_high' ? 'xhigh' : (level || 'medium');
  return `model_reasoning_effort="${normalized}"`;
}

// stderr lines containing this phrase are dropped (harmless noise on every run).
const STDERR_NOISE_PATTERNS = [
  /failed to record rollout items/i,
  /failed to refresh available models/i,
  // Internal tracing logs ("2026-06-09T21:46:40Z ERROR codex_core...: ...") are
  // CLI diagnostics, not agent output — real failures still surface via exit
  // code + the full stderr accumulator.
  /^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+\S*codex/i,
];

// Resume failures when the persisted thread id no longer exists on disk
// (Codex history pruned, version upgrade). Mirrors the Claude adapter's
// "No conversation found" detection so the bridge can clear the session
// and retry fresh instead of failing every turn forever.
const STALE_SESSION_PATTERNS = [
  // Single-line matches only — stderr is a multi-line accumulator full of
  // unrelated noise, so cross-line .* matches false-positive easily.
  /\b(thread|session|conversation|rollout)\b[^\n]*\b(not found|no longer|does not exist|missing)\b/i,
  /\b(no|failed to find|could not find|unable to load)\b[^\n]*\b(thread|session|conversation|rollout)\b/i,
  /failed to resume/i,
];

// codex exec --json never reports context-window fullness (turn.completed
// usage is a per-turn aggregate), but the session rollout file records
// token_count events with last_token_usage.total_tokens (== codex-rs
// tokens_in_context_window) and model_context_window. After each turn we
// tail the rollout and emit the real snapshot. Best-effort: any failure
// just leaves the context display unchanged.
const rolloutPathCache = new Map<string, string>();

async function findRolloutPath(threadId: string): Promise<string | null> {
  const cached = rolloutPathCache.get(threadId);
  if (cached && (await Bun.file(cached).exists())) return cached;
  const sessionsDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  try {
    const glob = new Bun.Glob(`**/rollout-*-${threadId}.jsonl`);
    for await (const p of glob.scan({ cwd: sessionsDir, absolute: true })) {
      rolloutPathCache.set(threadId, p);
      return p;
    }
  } catch {
    // sessions dir missing or unreadable
  }
  return null;
}

async function emitContextFromRollout(ctx: AgentRunContext, threadId: string): Promise<void> {
  const path = await findRolloutPath(threadId);
  if (!path) return;
  const f = Bun.file(path);
  const size = f.size;
  if (!size) return;
  const start = Math.max(0, size - 262_144);
  const text = await f.slice(start, size).text();
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('token_count')) continue;
    try {
      const payload = JSON.parse(line)?.payload;
      if (payload?.type !== 'token_count' || !payload.info) continue;
      const total = payload.info.last_token_usage?.total_tokens;
      const window = payload.info.model_context_window;
      const contextTokens = typeof total === 'number' && total >= 0 ? total : undefined;
      const contextLimit = typeof window === 'number' && window > 0 ? window : undefined;
      if (contextTokens !== undefined || contextLimit !== undefined) {
        ctx.emitAgentEvent({ type: 'usage', contextTokens, contextLimit });
      }
      return;
    } catch {
      // first line of the slice may be cut mid-JSON — keep walking back
    }
  }
}

async function emitSnapshotFromRollout(ctx: AgentRunContext, threadId: string): Promise<void> {
  const path = await findRolloutPath(threadId);
  if (!path) return;
  const f = Bun.file(path);
  const size = f.size;
  if (!size) return;
  let modelRan: string | undefined;
  let contextTokens: number | undefined;
  let contextLimit: number | undefined;

  const readLine = (line: string): void => {
    if (!line) return;
    try {
      const event = JSON.parse(line);
      const payload = event?.payload;
      if (!modelRan && event?.type === 'turn_context' && typeof payload?.model === 'string' && payload.model) {
        modelRan = payload.model;
      }
      if ((contextTokens === undefined || contextLimit === undefined) && payload?.type === 'token_count' && payload.info) {
        const total = payload.info.last_token_usage?.total_tokens;
        const window = payload.info.model_context_window;
        contextTokens = typeof total === 'number' && total >= 0 ? total : contextTokens;
        contextLimit = typeof window === 'number' && window > 0 ? window : contextLimit;
      }
    } catch {
      // Chunk boundaries can split a JSONL record; the next chunk completes it.
    }
  };

  const chunkSize = 1_048_576;
  let end = size;
  let suffix = '';
  while (end > 0 && !(modelRan && (contextTokens !== undefined || contextLimit !== undefined))) {
    const start = Math.max(0, end - chunkSize);
    const text = await f.slice(start, end).text();
    const lines = (text + suffix).split('\n');
    suffix = start > 0 ? (lines.shift() ?? '') : '';
    for (let i = lines.length - 1; i >= 0; i--) {
      readLine(lines[i] ?? '');
      if (modelRan && (contextTokens !== undefined || contextLimit !== undefined)) break;
    }
    end = start;
  }

  if (modelRan || contextTokens !== undefined || contextLimit !== undefined) {
    ctx.emitAgentEvent({ type: 'usage', contextTokens, contextLimit, modelRan });
    if (modelRan && ctx.model && modelRan !== ctx.model) {
      ctx.emitSystemMessage(
        `Requested Codex model "${ctx.model}" but the CLI actually ran "${modelRan}". ` +
        `This turn has been stamped with the actual model.`,
      );
    }
  }
}

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

export function codexImageArgs(imagePaths?: readonly string[]): string[] {
  return (imagePaths ?? []).flatMap(path => ['--image', path]);
}

export function resolveCodexLaunchCommand(
  codexBin: string,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
  nodeBin?: string,
): string[] {
  if (platform !== 'win32' || extname(codexBin).toLowerCase() !== '.cmd') return [codexBin];

  // npm's Windows shim runs through cmd.exe, whose command line limit is much
  // smaller than CreateProcess's native limit. A 100-image turn can therefore
  // fail even though the same argv is safe for node.exe. Launch the package's
  // JS entry point directly and let it hand off to the native Codex binary.
  const entrypoint = win32Path.resolve(
    win32Path.dirname(codexBin),
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  return pathExists(entrypoint) ? [nodeBin || resolveCliBinary('node'), entrypoint] : [codexBin];
}

export function buildCodexExecArgs(
  codexCommand: string | readonly string[],
  baseArgs: readonly string[],
  sessionId: string | null,
  imagePaths?: readonly string[],
): string[] {
  const command = typeof codexCommand === 'string' ? [codexCommand] : [...codexCommand];
  const imageArgs = codexImageArgs(imagePaths);
  // --image is variadic in `codex exec`. Keep the stdin prompt positional
  // before image flags, otherwise the final --image consumes `-` (and resume's
  // session positional) as another filename and Codex receives no prompt.
  return sessionId
    ? [...command, 'exec', 'resume', ...baseArgs, sessionId, '-', ...imageArgs]
    : [...command, 'exec', ...baseArgs, '-', ...imageArgs];
}

function codexToolName(item: any): string {
  if (item?.type === 'web_search') return 'WebSearch';
  if (item?.type === 'plan_update') return 'UpdatePlan';
  const tool = item?.tool ?? item?.tool_name ?? item?.name ?? 'tool';
  const server = item?.server ?? item?.server_name;
  if (typeof server === 'string' && server && typeof tool === 'string' && tool && !tool.startsWith(server + '.')) {
    return `${server}.${tool}`;
  }
  return typeof tool === 'string' && tool ? tool : 'tool';
}

function codexToolInput(item: any): unknown {
  const raw = item?.arguments ?? item?.input ?? item?.params;
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return { input: raw };
  }
}

function buildNoFinalFallback(lastProgress: string, model?: string): string {
  const progress = lastProgress.trim();
  const heading = 'Codex completed without emitting a final response.';
  const retry = 'This is an incomplete result. Use Retry to rerun the turn if a complete answer is still needed.';
  const modelLine = model ? `Model: Codex — ${model}` : 'Model: Codex — unavailable';
  if (!progress) return `${heading}\n\n${retry}\n\n${modelLine}`;
  return `${heading}\n\nLast progress update:\n\n${progress}\n\n${retry}\n\n${modelLine}`;
}

export function resolveCodexCompletion(
  finalText: string,
  lastAssistantMessage: string,
  hasFinalAssistantMessage: boolean,
  allowFallback: boolean,
  model?: string,
): string | null {
  const canonical = finalText.trim();
  if (canonical) {
    if (hasFinalAssistantMessage && canonical === lastAssistantMessage.trim()) return null;
    return canonical;
  }
  if (hasFinalAssistantMessage || !allowFallback) return null;
  return buildNoFinalFallback(lastAssistantMessage, model);
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
export function handleCodexEvent(ctx: AgentRunContext, state: CodexRunState, event: any): void {
  if (!event || typeof event !== 'object') return;

  const startTool = (name: string, input: unknown = {}) => {
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
  // input_tokens is the AGGREGATE across every model call in the turn (and
  // cached_input_tokens is a subset of it, per codex-rs TokenUsage), so it is
  // NOT a context snapshot — a long agentic turn sums to millions of tokens.
  // Context fullness comes from the session rollout file after the turn
  // (see emitContextFromRollout); here we only accumulate per-turn spend.
  if (event.type === 'turn.completed') {
    const usage = event.usage;
    if (usage && typeof usage === 'object') {
      const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      const outputTokens = (typeof usage.output_tokens === 'number' ? usage.output_tokens : 0)
        + (typeof usage.reasoning_output_tokens === 'number' ? usage.reasoning_output_tokens : 0);
      ctx.emitAgentEvent({
        type: 'usage',
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

  // --- Item: MCP/custom tools, web search, and plan updates ----------------
  // Current Codex JSONL reports these through the generic item lifecycle.
  // Older CLIs used the provider-specific *_begin / *_end events below.
  const isCurrentToolItem = item
    && (item.type === 'mcp_tool_call'
      || item.type === 'custom_tool_call'
      || item.type === 'web_search'
      || item.type === 'plan_update');
  if (event.type === 'item.started' && isCurrentToolItem) {
    startTool(codexToolName(item), codexToolInput(item));
    return;
  }
  if (event.type === 'item.completed' && isCurrentToolItem) {
    // Some CLI builds omit item.started for very fast tools. Emit a start in
    // that case so the UI still receives an activity update before closing it.
    if (!state.toolOpen) startTool(codexToolName(item), codexToolInput(item));
    closeTool();
    return;
  }

  // --- Item: agent_message --------------------------------------------------
  if (event.type === 'item.completed' && item?.type === 'agent_message') {
    const text = typeof item.text === 'string' ? item.text : extractText(item);
    if (text) {
      // codex exec --json does not expose the internal commentary/final phase
      // on agent_message items. Treat streamed messages as concise progress;
      // --output-last-message remains the canonical final response below.
      ctx.emitAgentEvent({ type: 'thinking-delta', text });
      state.lastAssistantMessage = text;
    }
    return;
  }

  if (event.type === 'item.completed' && item?.type === 'reasoning') {
    const text = extractText(item.summary ?? item.text ?? item);
    if (text) ctx.emitAgentEvent({ type: 'thinking-delta', text });
    return;
  }

  // --- Streamed assistant tokens --------------------------------------------
  if (event.type === 'agent_message_delta') {
    const delta = event.delta ?? event.text ?? event.content ?? '';
    if (typeof delta === 'string' && delta) ctx.emitAgentEvent({ type: 'thinking-delta', text: delta });
    return;
  }
  if (event.type === 'agent_message') {
    const content = event.message ?? event.content ?? event.text ?? '';
    if (typeof content === 'string' && content) ctx.emitAgentEvent({ type: 'thinking-delta', text: content });
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
    ctx.emitAgentEvent({ type: 'result', text: event.last_agent_message });
    state.hasFinalAssistantMessage = true;
    state.lastAssistantMessage = event.last_agent_message;
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
      toolOpen: false,
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
    // Always pin the reasoning effort. The Codex config key is
    // `model_reasoning_effort` — passing the wrong key (`reasoning_effort`) is
    // silently ignored, so the dropdown level never took and Codex fell back to
    // whatever ~/.codex/config.toml had. If that fallback is invalid for the
    // chosen model (e.g. an "ultra"/"max" tier the API rejects), every turn
    // 400s on reasoning.effort. We normalize the legacy "extra_high" spelling
    // to the CLI's "xhigh" and default to "medium" when no level is selected,
    // so a stale config value can never leak into a turn.
    baseArgs.push('-c', codexReasoningConfigArg(ctx.reasoningLevel));

    // Resolve to absolute path so Bun.spawn doesn't have to probe PATHEXT
    // from the agent's cwd (which fails on Windows for npm shim files).
    const codexCommand = resolveCodexLaunchCommand(resolveCliBinary('codex'));
    const sessionId = ctx.getSessionId();
    // Native attachments put every image directly into the model input. The
    // installed CLI supports --image on both fresh and resumed exec turns.
    const args = buildCodexExecArgs(codexCommand, baseArgs, sessionId, ctx.imagePaths);

    // The Codex CLI doesn't have an --append-system-prompt flag. We
    // prepend the agent-forge system prompt (guardrails + persona + notes
    // + docs + atlas citation) to the user message with clear markers so
    // the model can distinguish system context from the user's actual turn.
    const runtimeContext = [
      '=== AGENT-FORGE RUNTIME CONTEXT ===',
      'Provider: Codex',
      ctx.model ? `Configured model id for this turn: ${ctx.model}` : null,
      'If the user asks what model you are, answer from this runtime context instead of generic base instructions.',
      '=== END AGENT-FORGE RUNTIME CONTEXT ===',
    ].filter(Boolean).join('\n');
    const fullPrompt = ctx.systemPrompt
      ? `=== SYSTEM CONTEXT (provided by agent-forge — these instructions are load-bearing) ===\n${ctx.systemPrompt}\n=== END SYSTEM CONTEXT ===\n\n=== USER MESSAGE ===\n${prompt}`
      : prompt;
    const fullPromptWithRuntime = ctx.systemPrompt
      ? `${runtimeContext}\n\n${fullPrompt}`
      : `${runtimeContext}\n\n=== USER MESSAGE ===\n${fullPrompt}`;

    return {
      async run() {
        try {
          const env = createCliEnv();

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
            void killProcessTree(proc);
          }

          // Pipe the (system + user) prompt via stdin.
          try {
            proc.stdin.write(fullPromptWithRuntime);
            proc.stdin.end();
          } catch (e) {
            // Codex with `-` blocks reading stdin forever if the write failed —
            // kill it so the turn unwinds instead of wedging the agent.
            console.warn('[codex] stdin write failed; killing process:', e);
            void killProcessTree(proc);
          }

          // Drain stderr and filter known harmless noise. The chat bridge keeps
          // surviving diagnostic chunks hidden until a clean exit error is needed.
          const stderrPromise = (async () => {
            const reader = (proc!.stderr as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            let acc = '';
            let pendingLine = '';
            let suppressRouterBlock = false;
            let suppressSkillsLoaderBlock = false;
            let suppressedRouterLines = 0;
            let suppressedSkillsLoaderLines = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                if (!chunk) continue;
                acc += chunk;
                // Tail-cap so a chatty/looping CLI can't balloon memory.
                if (acc.length > 64_000) acc = acc.slice(-64_000);
                pendingLine += chunk;
                // Process complete lines for noise filtering; emit only what survives.
                let nlIdx: number;
                while ((nlIdx = pendingLine.indexOf('\n')) >= 0) {
                  const line = pendingLine.slice(0, nlIdx + 1);
                  pendingLine = pendingLine.slice(nlIdx + 1);
                  if (/codex_core::tools::router/i.test(line)) {
                    suppressRouterBlock = true;
                    suppressedRouterLines = 0;
                    continue;
                  }
                  if (/codex_core_skills::loader/i.test(line)) {
                    // Single-line errors end with "(os error N)" — drop just the
                    // line. Otherwise enter block mode to eat continuation lines.
                    if (!/\(os error \d+\)/i.test(line)) {
                      suppressSkillsLoaderBlock = true;
                      suppressedSkillsLoaderLines = 0;
                    }
                    continue;
                  }
                  if (suppressRouterBlock) {
                    suppressedRouterLines++;
                    if (line.trim() === '' || suppressedRouterLines > 40) {
                      suppressRouterBlock = false;
                      suppressedRouterLines = 0;
                    }
                    continue;
                  }
                  if (suppressSkillsLoaderBlock) {
                    suppressedSkillsLoaderLines++;
                    if (/\(os error 3\)/i.test(line) || line.trim() === '' || suppressedSkillsLoaderLines > 8) {
                      suppressSkillsLoaderBlock = false;
                      suppressedSkillsLoaderLines = 0;
                    }
                    continue;
                  }
                  if (!STDERR_NOISE_PATTERNS.some(re => re.test(line))) {
                    ctx.emitAgentEvent({ type: 'stderr', text: line });
                  }
                }
              }
              if (
                pendingLine
                && !suppressRouterBlock
                && !suppressSkillsLoaderBlock
                && !/codex_core::tools::router/i.test(pendingLine)
                && !/codex_core_skills::loader/i.test(pendingLine)
                && !STDERR_NOISE_PATTERNS.some(re => re.test(pendingLine))
              ) {
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
              // A single newline-free line growing without bound means the CLI
              // is emitting something we'll never parse — drop it rather than OOM.
              if (leftover.length > 10_000_000) {
                console.error('[codex] dropping >10MB unterminated stdout line');
                leftover = '';
              }
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
          // Read final assistant text from --output-last-message tmpfile.
          // Codex 0.125+ writes the canonical final answer here even when
          // the stream-event for item.completed/agent_message also ran.
          let finalText = '';
          try {
            const f = Bun.file(state.outputPath);
            if (await f.exists()) {
              finalText = (await f.text()).trim();
            }
          } finally {
            await unlink(state.outputPath).catch(() => {});
          }

          // Always emit the canonical final answer. If a clean Codex turn ends
          // without one, persist an explicitly incomplete fallback instead of
          // silently leaving the user's message unanswered.
          const completion = resolveCodexCompletion(
            finalText,
            state.lastAssistantMessage,
            state.hasFinalAssistantMessage,
            !killed && exitCode === 0,
            ctx.model,
          );
          if (completion) {
            ctx.emitAgentEvent({ type: 'result', text: completion });
            state.hasFinalAssistantMessage = true;
            state.lastAssistantMessage = completion;
          }

          // Stale-session resume failure: clear + retry fresh via the bridge,
          // mirroring the Claude adapter's "No conversation found" path.
          if (!killed && exitCode !== 0 && sessionId
              && STALE_SESSION_PATTERNS.some(re => re.test(stderrText))) {
            ctx.emitAgentEvent({ type: 'finish', reason: 'stale-session' });
            return { recoverableError: 'stale-session' as const, errorMessage: stderrText };
          }

          // Pull the real context-window snapshot from the session rollout.
          const threadId = ctx.getSessionId();
          if (!killed && threadId) {
            await emitSnapshotFromRollout(ctx, threadId).catch(() => {});
          }

          if (!killed && exitCode !== 0 && !state.hasFinalAssistantMessage) {
            // Stderr noise was filtered live; anything still here is real. With
            // nothing at all, the user must still see that the turn failed —
            // otherwise a crash looks like "Codex said nothing".
            ctx.emitAgentEvent({
              type: 'error',
              message: stderrText || `Codex CLI exited with code ${exitCode} and no output`,
            });
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
        // Set killed even before proc exists — run() checks it post-spawn so a
        // stop landing in the spawn window doesn't produce an orphan turn.
        killed = true;
        if (!proc) return;
        try {
          if (process.platform === 'win32') {
            // SIGINT isn't deliverable on Windows; Bun's kill() only terminates
            // the npm .cmd shim, leaving the real CLI running. Kill the tree.
            void killProcessTree(proc);
          } else {
            proc.kill('SIGINT');
          }
        } catch (e) {
          console.warn('[codex] stop() failed:', e);
        }
      },

      kill() {
        killed = true;
        if (!proc) return;
        try {
          void killProcessTree(proc);
        } catch (e) {
          console.warn('[codex] kill() failed:', e);
        }
      },
    };
  },
};

// Re-export so the registry import resolves cleanly when both adapters bundle.
export { drainStreamToString };
