import type { Subprocess } from 'bun';
import { watch, existsSync, mkdirSync, type FSWatcher } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentInfo, AgentStatus, ChatMessage } from '../../shared/protocol';
import { generateId, killProcessTree } from '../utils';
import { persistenceService } from './persistence.service';
import { noteService } from './note.service';
import { documentService } from './document.service';
import { workspaceService } from './workspace.service';
import { settingsService } from './settings.service';
import { broadcast } from '../broadcast';

const MAX_OUTPUT_BUFFER = 2_000_000;

const DEFAULT_GUARDRAILS = `IMPORTANT GUARDRAILS — follow these at all times:
- NEVER run git commit, git push, git push --force, or git merge unless the user EXPLICITLY asks you to.
- NEVER delete branches (git branch -D/-d) unless the user EXPLICITLY asks you to.
- NEVER run destructive commands (rm -rf, git reset --hard, git checkout ., git clean) unless the user EXPLICITLY asks you to.
- Before making changes, briefly state what you plan to do and which files you'll modify.
- If you're unsure about something, ask the user rather than guessing.`;

interface ManagedAgent {
  info: AgentInfo;
  process: Subprocess<'pipe', 'pipe', 'pipe'> | null;
  sessionId: string | null;
  outputBuffer: string;
  watcher: FSWatcher | null;
  lastFileChange: string[];
  pendingTimeouts: ReturnType<typeof setTimeout>[];
  contextTokens: number;
  contextLimit: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  numTurns: number;
}

// HMR-safe state
const agents: Map<string, ManagedAgent> = (globalThis as any).__agentsMap ??= new Map<string, ManagedAgent>();
const messages: Map<string, ChatMessage[]> = (globalThis as any).__messagesMap ??= new Map<string, ChatMessage[]>();
const sendLocks: Map<string, Promise<void>> = (globalThis as any).__sendLocks ??= new Map<string, Promise<void>>();
let sharedContext: string = (globalThis as any).__sharedContext ?? '';

// QA testing state — pending tests per QA agent (FIFO), and the GUI server port
// (set by index.ts after Bun.serve starts) for system-prompt URL substitution.
interface PendingQaTest {
  sourceAgentId: string;
  triggeredAt: number;
  hardKillTimer: ReturnType<typeof setTimeout> | null;
}
const pendingQaTests: Map<string, PendingQaTest[]> = (globalThis as any).__pendingQaTests ??= new Map<string, PendingQaTest[]>();
let guiPort: number = ((globalThis as any).__guiPort as number) || 0;

const QA_HARD_KILL_MS = 3 * 60 * 1000;

const QA_SYSTEM_PROMPT_TEMPLATE = `You are a UI QA Testing Agent. Your job is to visually test web applications by taking screenshots, analyzing them, clicking buttons, filling forms, and reporting issues.

## Available Browser Tools

Call these via curl to http://localhost:{GUI_PORT}/api/browser/.
Always include "workspaceId": "{WORKSPACE_ID}" in the JSON body or query string.

- POST /navigate {"workspaceId":"{WORKSPACE_ID}","url":"..."}
- POST /screenshot {"workspaceId":"{WORKSPACE_ID}","selector":"..." (optional),"fullPage":true (optional)}
  -> Returns {"path":"/path/to/screenshot.png"}
  -> Then use the Read tool on that path to see the rendered UI.
- POST /click {"workspaceId":"{WORKSPACE_ID}","selector":"..."}
- POST /type {"workspaceId":"{WORKSPACE_ID}","selector":"...","text":"..."}
- POST /wait-for-ready {"workspaceId":"{WORKSPACE_ID}"} -- wait for HMR/page to stabilize
- GET  /console?workspaceId={WORKSPACE_ID} -- recent console errors/warnings/logs
- POST /console/clear {"workspaceId":"{WORKSPACE_ID}"}

## Workflow

1. Call /wait-for-ready to let the page settle.
2. Navigate to the relevant page.
3. Take a screenshot and Read the image to see the UI.
4. Check /console for errors.
5. Test interactions (click buttons, fill forms).
6. Take screenshots after interactions to verify behavior.
7. Compile a report with findings and screenshot file paths.

## Default to exploration on open-ended prompts

When the user's instruction is open-ended ("describe what you see", "tell me about the page", "test the homepage", "screenshot the app"), interpret it generously. Don't stop at one screenshot of the initial paint. After the initial screenshot:
- Click 1-2 major navigation elements (tabs, primary buttons, prominent links) to see what they reveal.
- Screenshot after each click so the user can compare states.
- If you spot interactive elements (forms, dropdowns, draggable items), exercise at least one to confirm it responds.

When the user's instruction is specific ("click the login button", "test the form validation"), do exactly that and only that — don't go off-script.

The rule of thumb: if the user wrote a sentence longer than 10 words with specific verbs, follow it literally. If they wrote something vague like "test the page", explore.

## Time budget

If you spend more than 60 seconds attempting one specific action (e.g. searching for an element that won't appear, or clicking targets that don't respond), STOP and report what you tried. Don't loop endlessly. The user would rather see a partial report than a stuck agent.

## Report Format

ALWAYS lead with a single-line verdict header on the very first line of your report, in this exact format:

  ✅ PASS — short summary
  ⚠️ WARNINGS — short summary (use when there are non-blocking issues, e.g. console warnings, ergonomic concerns)
  ❌ FAIL — short summary (use when something is broken: page won't load, errors thrown, expected element missing)

Then structure the rest of the report as:
- Summary of what was tested
- Issues found (with screenshot paths)
- Things that look correct
- Console errors if any
- Overall assessment

Reference screenshot file paths in your report (e.g. "see screenshot at /path/to/file.png"). The system will automatically attach those screenshots as inline images in the report sent back to the coding agent.

Keep reports concise and actionable.`;

// Read from a stream reader with a timeout
async function readWithTimeout<T>(reader: ReadableStreamDefaultReader<T>, ms: number): Promise<{ done: boolean; value?: T }> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Stream read timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

function addMessage(agentId: string, role: ChatMessage['role'], content: string, imageData?: string, imageMimeType?: string, source?: 'qa'): ChatMessage {
  const msg: ChatMessage = {
    id: generateId(),
    agentId,
    role,
    content,
    timestamp: Date.now(),
  };
  if (imageData) msg.imageData = imageData;
  if (imageMimeType) msg.imageMimeType = imageMimeType;
  if (source) msg.source = source;
  if (!messages.has(agentId)) {
    messages.set(agentId, []);
  }
  messages.get(agentId)!.push(msg);
  persistenceService.save();
  return msg;
}

function agentTimeout(agentId: string, callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  const agent = agents.get(agentId);
  const timer = setTimeout(() => {
    if (agent) agent.pendingTimeouts = agent.pendingTimeouts.filter(t => t !== timer);
    callback();
  }, ms);
  if (agent) agent.pendingTimeouts.push(timer);
  return timer;
}

function clearAgentTimeouts(agentId: string): void {
  const agent = agents.get(agentId);
  if (agent) {
    for (const timer of agent.pendingTimeouts) clearTimeout(timer);
    agent.pendingTimeouts = [];
  }
}

// --- File Watcher ---

function startFileWatcher(agentId: string) {
  const agent = agents.get(agentId);
  if (!agent || !existsSync(agent.info.cwd)) return;

  if (agent.watcher) {
    agent.watcher.close();
    agent.watcher = null;
  }

  try {
    const changedFiles = new Set<string>();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    agent.watcher = watch(agent.info.cwd, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      if (filename.includes('node_modules') || filename.includes('.git/') || filename.startsWith('.')) return;

      changedFiles.add(filename);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const files = Array.from(changedFiles);
        changedFiles.clear();
        agent.lastFileChange = files;
        broadcast({ type: 'file_changed', agentId, files });
      }, 1000);
    });
  } catch (e) {
    console.error(`File watcher failed for agent ${agentId}:`, e);
  }
}

function stopFileWatcher(agentId: string) {
  const agent = agents.get(agentId);
  if (agent?.watcher) {
    agent.watcher.close();
    agent.watcher = null;
  }
}

// --- Process Management ---

async function spawnProcess(agentId: string): Promise<Subprocess<'pipe', 'pipe', 'pipe'> | null> {
  const agent = agents.get(agentId);
  if (!agent) return null;

  if (agent.process) {
    const oldPid = agent.process.pid;
    await killProcessTree(agent.process);
    if (oldPid) persistenceService.untrackPid(oldPid);
    agent.process = null;
  }

  try {
    const args = [
      'claude',
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    const appendParts: string[] = [DEFAULT_GUARDRAILS];
    if (agent.info.systemPrompt) {
      appendParts.push(`Agent Persona:\n${agent.info.systemPrompt}`);
    }
    if (sharedContext) {
      appendParts.push(`Project Context:\n${sharedContext}`);
    }
    const notesContext = noteService.getNotesForAgent(agentId);
    if (notesContext) {
      appendParts.push(notesContext);
    }
    const docsContext = documentService.getDocumentsForAgent(agentId, agent.info.workspaceId);
    if (docsContext) {
      appendParts.push(docsContext);
    }
    appendParts.push(`Plan Management:
When asked to create or update a plan, use the Write tool to write a markdown file to the .plans/ directory in your working directory.
- To create a new plan: Write to .plans/<plan-name>.md
- To update an existing plan: Write the complete updated content to the same file path
- Plans will automatically appear in the user's Plans sidebar for review
- Plans marked [APPROVED] should be followed as-is
- Plans marked [DRAFT] are pending user review`);

    const plansDir = join(agent.info.cwd, '.plans');
    try { mkdirSync(plansDir, { recursive: true }); } catch {}

    const settings = settingsService.get();
    if (settings.defaultSimulatorUdid) {
      const cwdLower = agent.info.cwd.toLowerCase();
      const isIos = cwdLower.includes('ios') || cwdLower.includes('xcode') || cwdLower.includes('swift') || cwdLower.includes('apple');
      if (isIos || settings.defaultSimulatorName) {
        appendParts.push(`Default iOS Simulator: ${settings.defaultSimulatorName || 'Unknown'} (UDID: ${settings.defaultSimulatorUdid})`);
      }
    }

    const validRefPaths: string[] = [];
    for (const dir of agent.info.referencePaths) {
      if (existsSync(dir)) {
        validRefPaths.push(dir);
        args.push('--add-dir', dir);
      }
    }
    if (validRefPaths.length > 0) {
      const refNames = validRefPaths.map(p => {
        const name = p.split('/').pop() || p;
        return `- ${name}: ${p}`;
      }).join('\n');
      appendParts.push(`Reference Directories (read-only context — you have full access to browse these):\n${refNames}\n\nIMPORTANT: These reference directories were explicitly added by the user as additional context for your work. You should be aware of them and use them when relevant. Your primary working directory is: ${agent.info.cwd}`);
    }

    args.push('--append-system-prompt', appendParts.join('\n\n'));

    if (agent.sessionId) {
      args.push('--resume', agent.sessionId);
    }

    console.log(`Spawning claude for agent ${agentId}:`, args.join(' '));

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const proc = Bun.spawn(args, {
      cwd: agent.info.cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
    });

    agent.process = proc;
    if (proc.pid) persistenceService.trackPid(proc.pid);
    return proc;
  } catch (e) {
    console.error(`Failed to spawn claude for agent ${agentId}:`, e);
    return null;
  }
}

// Parse stream-json output from Claude CLI
async function readStreamJson(agentId: string, proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<string> {
  const agent = agents.get(agentId);
  if (!agent) return '';

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let resultText = '';
  let hasSeenText = false;

  readStderr(agentId, proc.stderr).catch(e => console.error(`readStderr(${agentId}) error:`, e));

  try {
    while (true) {
      const { done, value } = await readWithTimeout(reader, 300_000);
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (buffer.length > MAX_OUTPUT_BUFFER) {
        buffer = buffer.slice(-MAX_OUTPUT_BUFFER);
      }

      for (let line of lines) {
        line = line.replace(/\r$/, '');
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);

          if (msg.type === 'system' && msg.subtype === 'init') {
            if (msg.session_id && msg.session_id !== agent.sessionId) {
              agent.sessionId = msg.session_id;
              persistenceService.save();
              console.log(`Agent ${agentId} session: ${msg.session_id}`);
            }
          } else if (msg.type === 'assistant') {
            const usage = msg.message?.usage;
            if (usage) {
              const contextUsed = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
              if (contextUsed > 0) {
                agent.contextTokens = contextUsed;
                agent.totalInputTokens += contextUsed;
              }
              if (usage.output_tokens) {
                agent.totalOutputTokens += usage.output_tokens;
              }
              broadcast({
                type: 'token_usage',
                agentId,
                contextTokens: agent.contextTokens,
                contextLimit: agent.contextLimit || 200000,
                totalInputTokens: agent.totalInputTokens,
                totalOutputTokens: agent.totalOutputTokens,
                totalCostUsd: agent.totalCostUsd,
                numTurns: agent.numTurns,
              });
            }
            const content = msg.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'thinking' && block.thinking) {
                  if (agent.info.status !== 'thinking') {
                    agent.info.status = 'thinking';
                    broadcast({ type: 'agent_updated', agent: agent.info });
                  }
                  broadcast({ type: 'thinking_output', agentId, content: block.thinking });
                } else if (block.type === 'text' && block.text) {
                  if (!hasSeenText && agent.info.status === 'thinking') {
                    hasSeenText = true;
                    agent.info.status = 'working';
                    broadcast({ type: 'agent_updated', agent: agent.info });
                  }
                  resultText += block.text;
                  broadcast({ type: 'output', agentId, content: block.text, stream: 'stdout' });
                  if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
                    agent.outputBuffer += block.text;
                  }
                } else if (block.type === 'tool_use') {
                  const toolInfo = `\n[Using tool: ${block.name}]\n`;
                  broadcast({ type: 'output', agentId, content: toolInfo, stream: 'stdout' });
                  if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
                    agent.outputBuffer += toolInfo;
                  }
                  // Intercept Write/Edit to .plans/ directory
                  if (block.name === 'Write' && block.input?.file_path) {
                    const fp: string = block.input.file_path;
                    if (fp.includes('.plans/') || fp.includes('.plans\\')) {
                      documentService.handlePlanWrite(agentId, agent.info.name, true, agent.info.workspaceId, fp, block.input.content || '');
                    }
                  } else if (block.name === 'Edit' && block.input?.file_path) {
                    const fp: string = block.input.file_path;
                    if (fp.includes('.plans/') || fp.includes('.plans\\')) {
                      agentTimeout(agentId, () => documentService.syncPlanFromFile(agentId, agent.info.name, true, agent.info.workspaceId, fp), 500);
                    }
                  }
                }
              }
            }
          } else if (msg.type === 'result') {
            if (!resultText && msg.result) {
              resultText = msg.result;
              broadcast({ type: 'output', agentId, content: msg.result, stream: 'stdout' });
              if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
                agent.outputBuffer += msg.result;
              }
            }

            if (msg.total_cost_usd) {
              agent.totalCostUsd = msg.total_cost_usd;
              console.log(`Agent ${agentId} cost: $${msg.total_cost_usd.toFixed(4)} (${msg.num_turns} turns)`);
            }
            if (msg.num_turns) {
              agent.numTurns = msg.num_turns;
            }
            if (msg.modelUsage) {
              for (const model of Object.values(msg.modelUsage) as any[]) {
                if (model.contextWindow) {
                  agent.contextLimit = model.contextWindow;
                }
              }
            }
            broadcast({
              type: 'token_usage',
              agentId,
              contextTokens: agent.contextTokens,
              contextLimit: agent.contextLimit || 200000,
              totalInputTokens: agent.totalInputTokens,
              totalOutputTokens: agent.totalOutputTokens,
              totalCostUsd: agent.totalCostUsd,
              numTurns: agent.numTurns,
            });

            if (msg.session_id) {
              agent.sessionId = msg.session_id;
            }
          }
        } catch (parseErr) {
          broadcast({ type: 'output', agentId, content: line, stream: 'stdout' });
          if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
            agent.outputBuffer += line;
          }
        }
      }
    }
  } catch (e) {
    // Stream closed or timed out
  } finally {
    reader.releaseLock();
  }

  return resultText;
}

async function readStderr(agentId: string, stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      broadcast({ type: 'output', agentId, content: text, stream: 'stderr' });
    }
  } catch (e) {
    // Stream closed
  } finally {
    reader.releaseLock();
  }
}

// --- Messaging implementation ---

async function _sendMessageImpl(agentId: string, content: string, source?: 'qa'): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) return;

  const userMsg = addMessage(agentId, 'user', content, undefined, undefined, source);
  broadcast({ type: 'message', message: userMsg });

  agent.outputBuffer = '';
  agent.info.status = 'working';
  broadcast({ type: 'agent_updated', agent: agent.info });

  const proc = await spawnProcess(agentId);

  if (!proc) {
    const errMsg = existsSync(agent.info.cwd)
      ? 'Failed to start Claude Code process. Is the `claude` CLI installed?'
      : `Working directory does not exist: ${agent.info.cwd}`;
    const sysMsg = addMessage(agentId, 'system', errMsg);
    broadcast({ type: 'message', message: sysMsg });
    agent.info.status = 'error';
    broadcast({ type: 'agent_updated', agent: agent.info });
    return;
  }

  try {
    proc.stdin.write(content + '\n');
    proc.stdin.end();

    const readPromise = readStreamJson(agentId, proc);
    const exitCode = await proc.exited;
    await readPromise;

    if (agent.outputBuffer.trim()) {
      const assistantMsg = addMessage(agentId, 'assistant', agent.outputBuffer.trim());
      broadcast({ type: 'message', message: assistantMsg });
    }

    await documentService.releaseLocksForAgent(agentId);
    if (proc.pid) persistenceService.untrackPid(proc.pid);
    agent.process = null;
    agent.info.status = exitCode === 0 ? 'idle' : 'error';
    broadcast({ type: 'agent_updated', agent: agent.info });
    await persistenceService.saveNow();

    // If this is a QA agent with a pending test, relay the report to the source coding agent.
    if (exitCode === 0 && pendingQaTests.has(agentId)) {
      _processQaIdle(agentId).catch(e => console.error(`QA idle relay failed for ${agentId}:`, e));
    }
  } catch (e) {
    console.error(`Error sending message to agent ${agentId}:`, e);
    if (proc.pid) persistenceService.untrackPid(proc.pid);
    agent.process = null;
    agent.info.status = 'error';
    broadcast({ type: 'agent_updated', agent: agent.info });
  }
}

// ============== QA orchestration ==============

/**
 * Build a context summary of a coding agent's conversation for the QA agent.
 *
 * Goal: enough context for the QA agent to know what was recently worked on,
 * without shipping the entire chat (which can balloon to 30KB+ when the user
 * has pasted plans, transcripts, etc.).
 *
 * Strategy:
 *   1. Sliding window of the last QA_SUMMARY_RECENT_MSGS messages.
 *   2. Per-message caps — generous enough that assistant code-change
 *      descriptions survive intact, but capped so a single huge paste
 *      can't dominate.
 *   3. Total-budget safety net — if the windowed/capped output still
 *      exceeds QA_SUMMARY_MAX_TOTAL, drop oldest messages until under.
 *   4. Note any trimming at the top so the QA agent knows context is partial.
 */
const QA_SUMMARY_RECENT_MSGS = 15;
const QA_SUMMARY_USER_CAP = 2000;
const QA_SUMMARY_ASSISTANT_CAP = 1000;
const QA_SUMMARY_MAX_TOTAL = 15000;

function buildChatSummary(agentId: string): string {
  const allMsgs = messages.get(agentId) || [];
  const turns = allMsgs.filter(m => m.role === 'user' || m.role === 'assistant');
  const start = Math.max(0, turns.length - QA_SUMMARY_RECENT_MSGS);
  const recent = turns.slice(start);
  let omitted = start;

  // Per-message caps with truncation markers.
  const formatted = recent.map(msg => {
    const cap = msg.role === 'user' ? QA_SUMMARY_USER_CAP : QA_SUMMARY_ASSISTANT_CAP;
    const role = msg.role === 'user' ? 'User' : 'Agent';
    const text = msg.content.length > cap
      ? msg.content.substring(0, cap) + `... [truncated, ${msg.content.length - cap} chars cut]`
      : msg.content;
    return `[${role}]: ${text}`;
  });

  // Total-budget walk: if still oversized, drop oldest until under.
  let totalLen = formatted.reduce((sum, t) => sum + t.length + 2, 0); // +2 for join separator
  while (totalLen > QA_SUMMARY_MAX_TOTAL && formatted.length > 1) {
    const dropped = formatted.shift()!;
    totalLen -= dropped.length + 2;
    omitted++;
  }

  const parts: string[] = [];
  if (omitted > 0) {
    parts.push(`(${omitted} earlier message${omitted === 1 ? '' : 's'} omitted for brevity)`);
  }
  parts.push(...formatted);
  return parts.join('\n\n');
}

/**
 * Find absolute screenshot paths the QA agent referenced in its report.
 * Matches any path-like string ending in .png that contains "agent-forge-qa"
 * (the screenshot dir signature). Tolerant of forward and back slashes so
 * Windows and POSIX paths both work.
 */
function scanForScreenshots(text: string): string[] {
  const re = /(?:[A-Za-z]:[\\\/]|\/)[^\s"'`<>()]*agent-forge-qa[^\s"'`<>()]*\.png/g;
  const found = new Set<string>();
  for (const m of text.matchAll(re)) found.add(m[0]);
  return Array.from(found);
}

async function readImageAsBase64(filePath: string): Promise<string | null> {
  try {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    // btoa expects a binary string
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  } catch {
    return null;
  }
}

/**
 * Called when a QA agent transitions to idle. Pops the oldest pending test,
 * extracts the report from the QA agent's last assistant message, sends it
 * to the source coding agent, persists screenshot messages, and broadcasts
 * qa_results_ready.
 */
async function _processQaIdle(qaAgentId: string): Promise<void> {
  const queue = pendingQaTests.get(qaAgentId);
  if (!queue || queue.length === 0) return;
  const test = queue.shift()!;
  if (queue.length === 0) pendingQaTests.delete(qaAgentId);
  if (test.hardKillTimer) clearTimeout(test.hardKillTimer);

  const qaMsgs = messages.get(qaAgentId) || [];
  const lastAssistant = [...qaMsgs].reverse().find(m => m.role === 'assistant');
  const reportText = lastAssistant?.content?.trim() || '(QA agent produced no output)';

  // 1) Send the report into the source coding agent's chat as a real turn,
  //    tagged source: 'qa' so the frontend can style it distinctly.
  await agentService.sendMessage(test.sourceAgentId, reportText, 'qa').catch(e => {
    console.error(`Failed to relay QA report to ${test.sourceAgentId}:`, e);
  });

  // 2) Attach any referenced screenshots as display-only system messages.
  const paths = scanForScreenshots(reportText);
  for (const p of paths) {
    const data = await readImageAsBase64(p);
    if (!data) continue;
    const screenshotMsg = addMessage(test.sourceAgentId, 'system', `QA screenshot: ${p}`, data, 'image/png', 'qa');
    broadcast({ type: 'message', message: screenshotMsg });
  }

  // 3) Tell the frontend to flag the unread badge on the source agent's 🧪 button.
  const sourceAgent = agents.get(test.sourceAgentId);
  const workspaceId = sourceAgent?.info.workspaceId;
  if (workspaceId) {
    broadcast({ type: 'qa_results_ready', workspaceId, sourceAgentId: test.sourceAgentId });
  }

  // 4) If more pending tests are queued for this QA agent, the next one's
  //    sendMessage is already serialized via sendLocks — nothing more to do.
}

async function _stopAgentImpl(agentId: string): Promise<boolean> {
  const agent = agents.get(agentId);
  if (!agent) return false;

  if (agent.process) {
    const pid = agent.process.pid;
    await killProcessTree(agent.process);
    if (pid) persistenceService.untrackPid(pid);
    agent.process = null;
  }

  if (agent.outputBuffer.trim()) {
    const partialMsg = addMessage(agentId, 'assistant', agent.outputBuffer.trim() + '\n\n[Stopped by user]');
    broadcast({ type: 'message', message: partialMsg });
    agent.outputBuffer = '';
  }

  clearAgentTimeouts(agentId);
  await documentService.releaseLocksForAgent(agentId);
  agent.info.status = 'idle';
  broadcast({ type: 'agent_updated', agent: agent.info });
  return true;
}

async function _killAgentImpl(agentId: string): Promise<boolean> {
  const agent = agents.get(agentId);
  if (!agent) return false;

  if (agent.process) {
    const pid = agent.process.pid;
    await killProcessTree(agent.process);
    if (pid) persistenceService.untrackPid(pid);
    agent.process = null;
  }

  clearAgentTimeouts(agentId);
  await documentService.releaseLocksForAgent(agentId);
  agent.info.status = 'stopped';
  broadcast({ type: 'agent_updated', agent: agent.info });
  await persistenceService.saveNow();
  return true;
}

export const agentService = {
  // --- Getters ---

  getAgents(): AgentInfo[] {
    return Array.from(agents.values()).map(a => a.info);
  },

  getAgent(id: string): AgentInfo | undefined {
    return agents.get(id)?.info;
  },

  getMessages(agentId: string): ChatMessage[] {
    return messages.get(agentId) || [];
  },

  getSharedContext(): string {
    return sharedContext;
  },

  getTokenUsage(agentId: string): { contextTokens: number; contextLimit: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number; numTurns: number } | null {
    const agent = agents.get(agentId);
    if (!agent) return null;
    return {
      contextTokens: agent.contextTokens,
      contextLimit: 200000,
      totalInputTokens: agent.totalInputTokens,
      totalOutputTokens: agent.totalOutputTokens,
      totalCostUsd: agent.totalCostUsd,
      numTurns: agent.numTurns,
    };
  },

  /** Check if an agent's process is running */
  isRunning(agentId: string): boolean {
    return agents.get(agentId)?.process !== null;
  },

  /** Get agent name (for plan writes) */
  getAgentName(agentId: string): string {
    return agents.get(agentId)?.info.name || 'unknown';
  },

  /** Get agent workspaceId */
  getAgentWorkspaceId(agentId: string): string | undefined {
    return agents.get(agentId)?.info.workspaceId;
  },

  // --- Agent CRUD ---

  async createAgent(name: string, cwd: string, referencePaths: string[] = [], systemPrompt: string = '', workspaceId?: string): Promise<AgentInfo> {
    if (!existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    let wsId = workspaceId;
    if (!wsId) {
      wsId = settingsService.getRef().activeWorkspaceId;
    }
    if (!wsId || !workspaceService.has(wsId)) {
      wsId = Array.from(workspaceService.keys())[0];
    }
    if (!wsId) {
      const ws = await workspaceService.create('Default');
      wsId = ws.id;
    }

    const id = generateId();
    const info: AgentInfo = {
      id,
      name,
      cwd,
      referencePaths,
      systemPrompt,
      status: 'idle',
      createdAt: Date.now(),
      workspaceId: wsId,
    };

    agents.set(id, {
      info,
      process: null,
      sessionId: null,
      outputBuffer: '',
      watcher: null,
      lastFileChange: [],
      pendingTimeouts: [],
      contextTokens: 0,
      contextLimit: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      numTurns: 0,
    });

    workspaceService.addAgentToWorkspace(wsId, id);
    startFileWatcher(id);
    documentService.startPlansWatcher(id, cwd);
    await persistenceService.saveNow();
    return agents.get(id)!.info;
  },

  async removeAgent(agentId: string): Promise<boolean> {
    const agent = agents.get(agentId);
    if (!agent) return false;

    if (agent.process) {
      const pid = agent.process.pid;
      await killProcessTree(agent.process);
      if (pid) persistenceService.untrackPid(pid);
      agent.process = null;
    }
    stopFileWatcher(agentId);
    documentService.stopPlansWatcher(agentId);
    await documentService.releaseLocksForAgent(agentId);
    workspaceService.removeAgentFromAllWorkspaces(agentId);

    agents.delete(agentId);
    messages.delete(agentId);
    await persistenceService.saveNow();
    return true;
  },

  async updateAgent(agentId: string, updates: { name?: string; cwd?: string; referencePaths?: string[]; systemPrompt?: string }): Promise<AgentInfo | null> {
    const agent = agents.get(agentId);
    if (!agent) return null;

    if (updates.cwd !== undefined) {
      if (!existsSync(updates.cwd)) {
        throw new Error(`Working directory does not exist: ${updates.cwd}`);
      }
      const cwdChanged = updates.cwd !== agent.info.cwd;
      agent.info.cwd = updates.cwd;
      if (cwdChanged) {
        stopFileWatcher(agentId);
        startFileWatcher(agentId);
      }
    }

    if (updates.name !== undefined) agent.info.name = updates.name;
    if (updates.referencePaths !== undefined) agent.info.referencePaths = updates.referencePaths;
    if (updates.systemPrompt !== undefined) agent.info.systemPrompt = updates.systemPrompt;

    await persistenceService.saveNow();
    return agent.info;
  },

  async clearHistory(agentId: string): Promise<boolean> {
    const agent = agents.get(agentId);
    if (!agent) return false;
    messages.set(agentId, []);
    agent.sessionId = null;
    await persistenceService.saveNow();
    return true;
  },

  // --- Agent Control ---

  async sendMessage(agentId: string, content: string, source?: 'qa'): Promise<void> {
    const prev = sendLocks.get(agentId) ?? Promise.resolve();
    const current = prev.then(
      () => _sendMessageImpl(agentId, content, source),
      () => _sendMessageImpl(agentId, content, source),
    ).catch(e => { console.error(`sendMessage(${agentId}) error:`, e); });
    sendLocks.set(agentId, current);
    return current;
  },

  async stopAgent(agentId: string): Promise<boolean> {
    // Execute immediately — don't queue behind sendLocks.
    // Killing the process causes the in-flight sendMessage to resolve naturally.
    // Reset the lock chain so queued sends after stop don't run stale.
    sendLocks.delete(agentId);
    return _stopAgentImpl(agentId);
  },

  async killAgent(agentId: string): Promise<boolean> {
    // Execute immediately — same reasoning as stopAgent.
    sendLocks.delete(agentId);
    return _killAgentImpl(agentId);
  },

  // --- Shared Context ---

  async updateSharedContext(content: string): Promise<void> {
    sharedContext = content;
    (globalThis as any).__sharedContext = content;
    await persistenceService.saveNow();
  },

  // --- Image handling ---

  async sendImage(agentId: string, imageData: string, mimeType: string, prompt?: string): Promise<void> {
    const agent = agents.get(agentId);
    if (!agent) return;

    const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/gif' ? '.gif' : mimeType === 'image/webp' ? '.webp' : '.png';
    const filename = `screenshot_${Date.now()}${ext}`;
    const filepath = join(tmpdir(), filename);

    try {
      const buffer = Buffer.from(imageData, 'base64');
      await Bun.write(filepath, buffer);

      const imgMsg = addMessage(agentId, 'user', `[Image uploaded: ${filename}]` + (prompt ? '\n' + prompt : ''), imageData, mimeType);
      broadcast({ type: 'message', message: imgMsg });

      const content = prompt
        ? `I've uploaded a screenshot/image for you to examine: ${filepath}\n\n${prompt}`
        : `I've uploaded a screenshot/image for you to examine: ${filepath}\nPlease examine this image file and describe what you see or act on it as appropriate.`;
      await agentService.sendMessage(agentId, content);
    } catch (e) {
      console.error(`Failed to save image for agent ${agentId}:`, e);
      const errMsg = addMessage(agentId, 'system', 'Failed to process uploaded image.');
      broadcast({ type: 'message', message: errMsg });
    }
  },

  // --- Multi-image handling ---

  async sendImages(agentId: string, images: { imageData: string; mimeType: string }[], prompt?: string): Promise<void> {
    const agent = agents.get(agentId);
    if (!agent || images.length === 0) return;

    try {
      const filePaths: string[] = [];
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const ext = img.mimeType === 'image/png' ? '.png' : img.mimeType === 'image/jpeg' ? '.jpg' : img.mimeType === 'image/gif' ? '.gif' : img.mimeType === 'image/webp' ? '.webp' : '.png';
        const filename = `screenshot_${Date.now()}_${i}${ext}`;
        const filepath = join(tmpdir(), filename);
        const buffer = Buffer.from(img.imageData, 'base64');
        await Bun.write(filepath, buffer);
        filePaths.push(filepath);
      }

      // Add chat message with first image data for preview
      const label = `[${images.length} image${images.length > 1 ? 's' : ''} uploaded]` + (prompt ? '\n' + prompt : '');
      const imgMsg = addMessage(agentId, 'user', label, images[0].imageData, images[0].mimeType);
      broadcast({ type: 'message', message: imgMsg });

      // Build combined prompt listing all file paths
      const fileList = filePaths.map((fp, i) => `Image ${i + 1}: ${fp}`).join('\n');
      const content = prompt
        ? `I've uploaded ${images.length} screenshot(s)/image(s) for you to examine:\n${fileList}\n\n${prompt}`
        : `I've uploaded ${images.length} screenshot(s)/image(s) for you to examine:\n${fileList}\nPlease examine these image files and describe what you see or act on them as appropriate.`;
      await agentService.sendMessage(agentId, content);
    } catch (e) {
      console.error(`Failed to save images for agent ${agentId}:`, e);
      const errMsg = addMessage(agentId, 'system', 'Failed to process uploaded images.');
      broadcast({ type: 'message', message: errMsg });
    }
  },

  // --- Shutdown & Kill All ---

  async shutdownAll(): Promise<void> {
    console.log('Shutting down all agent processes...');
    const kills: Promise<void>[] = [];

    for (const [agentId, agent] of agents) {
      clearAgentTimeouts(agentId);
      if (agent.process) {
        const pid = agent.process.pid;
        kills.push(killProcessTree(agent.process).then(() => {
          if (pid) persistenceService.getActivePids().delete(pid);
        }));
        agent.process = null;
      }
    }

    await Promise.race([
      Promise.all(kills),
      new Promise<void>(resolve => setTimeout(resolve, 3000)),
    ]);
  },

  async killAllProcesses(): Promise<{ success: boolean; message: string }> {
    console.log('KILL ALL: Killing all claude.exe processes machine-wide...');
    try {
      const proc = Bun.spawn(['taskkill', '/F', '/IM', 'claude.exe', '/T'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      for (const agent of agents.values()) {
        agent.process = null;
        agent.info.status = 'stopped';
        broadcast({ type: 'agent_updated', agent: agent.info });
        await documentService.releaseLocksForAgent(agent.info.id);
      }

      persistenceService.clearAllPids();
      await persistenceService.savePidsNow();
      await persistenceService.saveNow();

      return { success: true, message: 'All Claude processes killed.' };
    } catch (e: any) {
      console.error('killAllProcesses failed:', e);
      return { success: false, message: e.message || 'Failed to kill processes' };
    }
  },

  // --- QA testing ---

  /** Called by index.ts after Bun.serve starts so the QA system prompt has a real port. */
  setGuiPort(port: number): void {
    guiPort = port;
    (globalThis as any).__guiPort = port;
  },

  /**
   * Send a message from a coding agent's QA panel to the workspace's QA agent.
   * Spawns the QA agent on first call (lazy provisioning). Builds a chat
   * summary of the source coding agent's conversation, prepends it to the
   * user's content, and forwards to the QA agent's sendMessage. The pending
   * test is recorded with a 3-minute hard-kill backstop; when the QA agent
   * goes idle, _processQaIdle relays the report back into the source coding
   * agent's chat.
   */
  async sendQaMessage(workspaceId: string, sourceAgentId: string, userContent: string): Promise<void> {
    const ws = workspaceService.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (!ws.testUrl) throw new Error('Workspace has no Test URL set');
    if (!agents.has(sourceAgentId)) throw new Error(`Source agent not found: ${sourceAgentId}`);

    // 1) Resolve / provision the QA agent.
    let qaAgentId = ws.qaAgentId;
    if (!qaAgentId || !agents.has(qaAgentId)) {
      const qaCwd = join(tmpdir(), 'agent-forge-qa', workspaceId);
      if (!existsSync(qaCwd)) mkdirSync(qaCwd, { recursive: true });
      const port = guiPort > 0 ? guiPort : 3333;
      const systemPrompt = QA_SYSTEM_PROMPT_TEMPLATE
        .replace(/{GUI_PORT}/g, String(port))
        .replace(/{WORKSPACE_ID}/g, workspaceId);
      const created = await agentService.createAgent('QA Tester', qaCwd, [], systemPrompt, workspaceId);
      qaAgentId = created.id;
      const updated = await workspaceService.update(workspaceId, { qaAgentId } as any);
      if (updated) broadcast({ type: 'workspace_updated', workspace: updated });
    }

    // 2) Build the trigger message: chat summary + the user's QA-panel input.
    const summary = buildChatSummary(sourceAgentId);
    const triggerMessage = [
      'A user is asking the QA testing agent (you) to test something. Below is a context summary of their recent conversation with the coding agent, followed by their actual instruction.',
      '',
      `Test URL: ${ws.testUrl}`,
      `Workspace ID: ${workspaceId}`,
      '',
      '## Recent conversation with coding agent',
      '',
      summary || '(no prior conversation)',
      '',
      '## User instruction',
      '',
      userContent,
    ].join('\n');

    // 3) Record pending test with 3-minute hard-kill backstop.
    const test: PendingQaTest = {
      sourceAgentId,
      triggeredAt: Date.now(),
      hardKillTimer: null,
    };
    test.hardKillTimer = setTimeout(() => {
      console.warn(`[qa] hard-kill triggered for ${qaAgentId} after ${QA_HARD_KILL_MS}ms`);
      agentService.stopAgent(qaAgentId!).catch(() => {});
    }, QA_HARD_KILL_MS);

    if (!pendingQaTests.has(qaAgentId)) pendingQaTests.set(qaAgentId, []);
    pendingQaTests.get(qaAgentId)!.push(test);

    // 4) Forward to the QA agent. sendMessage uses the existing sendLocks
    //    queue, so concurrent sendQaMessage calls serialize cleanly.
    await agentService.sendMessage(qaAgentId, triggerMessage);
  },

  // --- Set agent workspace (for migration) ---
  setAgentWorkspace(agentId: string, wsId: string): void {
    const agent = agents.get(agentId);
    if (agent && !agent.info.workspaceId) {
      agent.info.workspaceId = wsId;
    }
  },

  // --- Load persisted agents ---

  load(data: { agents: any[]; messages: ChatMessage[]; sharedContext: string }) {
    for (const agentData of data.agents) {
      const managed: ManagedAgent = {
        info: {
          ...agentData,
          status: 'stopped' as AgentStatus,
          referencePaths: agentData.referencePaths || [],
          systemPrompt: agentData.systemPrompt || '',
          workspaceId: agentData.workspaceId || '',
        },
        process: null,
        sessionId: agentData.sessionId || null,
        outputBuffer: '',
        watcher: null,
        lastFileChange: [],
        pendingTimeouts: [],
        contextTokens: agentData.contextTokens || 0,
        contextLimit: agentData.contextLimit || 200000,
        totalInputTokens: agentData.totalInputTokens || 0,
        totalOutputTokens: agentData.totalOutputTokens || 0,
        totalCostUsd: agentData.totalCostUsd || 0,
        numTurns: agentData.numTurns || 0,
      };
      agents.set(agentData.id, managed);
      startFileWatcher(agentData.id);
      documentService.startPlansWatcher(agentData.id, agentData.cwd);
    }

    for (const msg of data.messages) {
      if (!messages.has(msg.agentId)) {
        messages.set(msg.agentId, []);
      }
      messages.get(msg.agentId)!.push(msg);
    }

    sharedContext = data.sharedContext || '';
    (globalThis as any).__sharedContext = sharedContext;
  },

  /** Reassign agents from one workspace to another */
  reassignAgents(fromWsId: string, toWsId: string): void {
    for (const managed of agents.values()) {
      if (managed.info.workspaceId === fromWsId) {
        managed.info.workspaceId = toWsId;
      }
    }
  },

  /** Build persisted agent data for persistence service */
  buildPersistedAgents(): any[] {
    return Array.from(agents.values()).map(a => ({
      ...a.info,
      sessionId: a.sessionId,
      contextTokens: a.contextTokens,
      contextLimit: a.contextLimit,
      totalInputTokens: a.totalInputTokens,
      totalOutputTokens: a.totalOutputTokens,
      totalCostUsd: a.totalCostUsd,
      numTurns: a.numTurns,
    }));
  },

  buildPersistedMessages(): ChatMessage[] {
    return Array.from(messages.values()).flat();
  },
};

// Wire up cross-service callbacks — must be called after all modules are initialized
export function initAgentService() {
  documentService._onPlanFileChanged = (agentId: string, filePath: string) => {
    const agent = agents.get(agentId);
    if (!agent) return;
    documentService.syncPlanFromFile(agentId, agent.info.name, agent.process !== null, agent.info.workspaceId, filePath);
  };
}
