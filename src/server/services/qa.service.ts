import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ChatMessage } from '../../shared/protocol';
import { broadcast } from '../broadcast';
import { agentService } from './agent.service';
import { workspaceService } from './workspace.service';
import { QA_SYSTEM_PROMPT_TEMPLATE } from './prompts/qa-system-prompt';

// --- HMR-safe state ---------------------------------------------------------

interface PendingQaTest {
  sourceAgentId: string;
  triggeredAt: number;
  hardKillTimer: ReturnType<typeof setTimeout> | null;
}

const pendingQaTests: Map<string, PendingQaTest[]> = (globalThis as any).__pendingQaTests ??= new Map<string, PendingQaTest[]>();

// GUI port set by index.ts after Bun.serve binds. Used to substitute {GUI_PORT}
// into the QA system prompt so the agent can call http://localhost:<port>/api/browser/*.
let guiPort: number = ((globalThis as any).__guiPort as number) || 0;

// --- Timing constants -------------------------------------------------------

const QA_HARD_KILL_MS = 30 * 60 * 1000;

const QA_SUMMARY_RECENT_MSGS = 15;
const QA_SUMMARY_USER_CAP = 2000;
const QA_SUMMARY_ASSISTANT_CAP = 1000;
const QA_SUMMARY_MAX_TOTAL = 15000;

// --- Helpers ---------------------------------------------------------------

/**
 * Build a context summary of a coding agent's conversation for the QA agent.
 *
 * Strategy:
 *   1. Sliding window of the last QA_SUMMARY_RECENT_MSGS messages.
 *   2. Per-message caps so a single huge paste can't dominate.
 *   3. Total-budget safety net — drop oldest until under QA_SUMMARY_MAX_TOTAL.
 *   4. Note any trimming so the QA agent knows context is partial.
 */
function buildChatSummary(agentId: string): string {
  const allMsgs = agentService.getMessages(agentId);
  const turns = allMsgs.filter(m => m.role === 'user' || m.role === 'assistant');
  const start = Math.max(0, turns.length - QA_SUMMARY_RECENT_MSGS);
  const recent = turns.slice(start);
  let omitted = start;

  const formatted = recent.map(msg => {
    const cap = msg.role === 'user' ? QA_SUMMARY_USER_CAP : QA_SUMMARY_ASSISTANT_CAP;
    const role = msg.role === 'user' ? 'User' : 'Agent';
    const text = msg.content.length > cap
      ? msg.content.substring(0, cap) + `... [truncated, ${msg.content.length - cap} chars cut]`
      : msg.content;
    return `[${role}]: ${text}`;
  });

  let totalLen = formatted.reduce((sum, t) => sum + t.length + 2, 0);
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
 * Matches any path-like string ending in .png that contains "agent-forge-qa".
 * Tolerant of forward and back slashes so Windows and POSIX paths both work.
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
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    return btoa(binary);
  } catch {
    return null;
  }
}

/**
 * Infer a verdict from a finished report's body when the agent didn't emit one.
 * Heuristics in priority order (FAIL > WARN > PASS, first match wins).
 */
function inferVerdictFromReport(text: string): { kind: 'pass' | 'warn' | 'fail'; summary: string } {
  if (
    /page (?:didn'?t|did not|failed to) load/i.test(text) ||
    /uncaught (?:exception|error)/i.test(text) ||
    /threw (?:an?\s+)?(?:error|exception)/i.test(text) ||
    /critical (?:error|failure|issue)/i.test(text) ||
    /\bcompletely broken\b/i.test(text) ||
    /\bcould not load\b/i.test(text)
  ) {
    return { kind: 'fail', summary: 'inferred from report content (no verdict line emitted)' };
  }
  if (
    (/issues?\s+found/i.test(text) && !/no\s+issues?\s+(?:found|to\s+report)/i.test(text)) ||
    /\d+\+?\s*(?:console\s+)?warnings?/i.test(text) ||
    /console\s+(?:warning|warn)/i.test(text) ||
    /ergonomic\s+(?:concern|issue|problem)/i.test(text) ||
    (/\b(?:bug|broken|spam|noise|concern|problem|misleading|hostile)\b/i.test(text) &&
     !/(?:no|nothing|zero)\s+(?:bug|broken|concerns?|problems?)\b/i.test(text))
  ) {
    return { kind: 'warn', summary: 'inferred from report content (no verdict line emitted)' };
  }
  return { kind: 'pass', summary: 'inferred from report content (no verdict line emitted)' };
}

/**
 * Called when a QA agent transitions to idle. Pops the oldest pending test,
 * extracts the report from the QA agent's last assistant message, sends it
 * to the source coding agent, persists screenshot messages, and broadcasts
 * qa_results_ready.
 */
async function processQaIdle(qaAgentId: string): Promise<void> {
  const queue = pendingQaTests.get(qaAgentId);
  if (!queue || queue.length === 0) return;
  const test = queue.shift()!;
  if (queue.length === 0) pendingQaTests.delete(qaAgentId);
  if (test.hardKillTimer) clearTimeout(test.hardKillTimer);

  const lastAssistant = agentService.getLastAssistantMessage(qaAgentId);
  let reportText = lastAssistant?.content?.trim() || '(QA agent produced no output)';

  const isInterrupted = /\[Stopped[: ]/.test(reportText);
  const hasVerdict = /(?:^|\n)[ \t]*(?:#{0,3}[ \t]*)?(?:✅\s*|⚠️\s*|❌\s*)?(PASS|WARNINGS?|FAIL)\b/i.test(reportText);
  if (isInterrupted && !hasVerdict) {
    const elapsedMs = Date.now() - test.triggeredAt;
    const elapsedStr = elapsedMs >= 60000
      ? `${Math.floor(elapsedMs / 60000)}m ${Math.round((elapsedMs % 60000) / 1000)}s`
      : `${Math.round(elapsedMs / 1000)}s`;
    const isTimeout = /\[Stopped: time limit/.test(reportText);
    const killMin = Math.round(QA_HARD_KILL_MS / 60000);
    const reasonLabel = isTimeout
      ? `the ${killMin}-minute hard-kill timer fired (${elapsedStr} elapsed)`
      : `the test was aborted by the user (${elapsedStr} elapsed)`;
    reportText = [
      `⚠️ WARNINGS — test was interrupted before completion`,
      ``,
      `**Why:** ${reasonLabel}.`,
      `**What this means:** the agent didn't get to write a structured report or final verdict — what follows is the raw partial transcript of what it did before being stopped.`,
      ``,
      `## Partial transcript`,
      ``,
      reportText,
    ].join('\n');
  } else if (!hasVerdict) {
    const inferred = inferVerdictFromReport(reportText);
    const emoji = inferred.kind === 'pass' ? '✅' : inferred.kind === 'warn' ? '⚠️' : '❌';
    const label = inferred.kind === 'pass' ? 'PASS' : inferred.kind === 'warn' ? 'WARNINGS' : 'FAIL';
    reportText = `${emoji} ${label} — ${inferred.summary}\n\n${reportText}`;
    console.log(`[qa] verdict inferred for ${qaAgentId}: ${label}`);
  }

  // 1) Relay the report into the source coding agent's chat as a real turn.
  await agentService.sendMessage(test.sourceAgentId, reportText, 'qa').catch(e => {
    console.error(`Failed to relay QA report to ${test.sourceAgentId}:`, e);
  });

  // 2) Attach any referenced screenshots as display-only system messages.
  const paths = scanForScreenshots(reportText);
  for (const p of paths) {
    const data = await readImageAsBase64(p);
    if (!data) continue;
    const screenshotMsg = agentService.addSystemMessage(test.sourceAgentId, `QA screenshot: ${p}`, data, 'image/png', 'qa');
    broadcast({ type: 'message', message: screenshotMsg });
  }

  // 3) Flag the unread badge on the source agent's QA button + stamp surface verifications.
  const workspaceId = agentService.getAgentWorkspaceId(test.sourceAgentId);
  if (workspaceId) {
    broadcast({ type: 'qa_results_ready', workspaceId, sourceAgentId: test.sourceAgentId });

    const ws = workspaceService.get(workspaceId);
    if (ws && ws.atlasProjectCwd) {
      const slugRe = /\bsurface\.([a-z0-9][a-z0-9-]*)/gi;
      const slugs = new Set<string>();
      for (const m of reportText.matchAll(slugRe)) slugs.add(m[1]!.toLowerCase());
      if (slugs.size > 0) {
        const map = ws.qaSurfaceVerifications ?? {};
        const now = Date.now();
        for (const slug of slugs) map[slug] = now;
        await workspaceService.update(workspaceId, { qaSurfaceVerifications: map });
        broadcast({ type: 'workspace_updated', workspace: ws });
        console.log(`[qa] stamped ${slugs.size} surface verification(s) for workspace ${workspaceId}: ${[...slugs].join(', ')}`);
      }
    }
  }
}

// --- Public API -------------------------------------------------------------

export const qaService = {
  /** Called by index.ts after Bun.serve binds — substituted into the QA system prompt. */
  setGuiPort(port: number): void {
    guiPort = port;
    (globalThis as any).__guiPort = port;
  },

  /** True if this agent is a QA agent with a pending test queued. */
  hasPendingTest(agentId: string): boolean {
    return pendingQaTests.has(agentId);
  },

  /**
   * Send a message from a coding agent's QA panel to the workspace's QA agent.
   * Spawns the QA agent on first call (lazy provisioning). Builds a chat
   * summary of the source coding agent's conversation, prepends it to the
   * user's content, and forwards to the QA agent's sendMessage. The pending
   * test is recorded with a 30-minute hard-kill backstop; when the QA agent
   * goes idle, processQaIdle relays the report back into the source coding
   * agent's chat.
   */
  async sendQaMessage(workspaceId: string, sourceAgentId: string, userContent: string): Promise<void> {
    const ws = workspaceService.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (!ws.testUrl) throw new Error('Workspace has no Test URL set');
    if (!agentService.getAgent(sourceAgentId)) throw new Error(`Source agent not found: ${sourceAgentId}`);

    // 1) Resolve / provision the QA agent.
    let qaAgentId = ws.qaAgentId;
    if (!qaAgentId || !agentService.getAgent(qaAgentId)) {
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

    // 2) Build the trigger message.
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

    // 3) Record pending test with hard-kill backstop.
    const test: PendingQaTest = {
      sourceAgentId,
      triggeredAt: Date.now(),
      hardKillTimer: null,
    };
    test.hardKillTimer = setTimeout(() => {
      console.warn(`[qa] hard-kill triggered for ${qaAgentId} after ${QA_HARD_KILL_MS}ms`);
      agentService.stopAgent(qaAgentId!, 'timeout').catch(() => {});
    }, QA_HARD_KILL_MS);

    if (!pendingQaTests.has(qaAgentId)) pendingQaTests.set(qaAgentId, []);
    pendingQaTests.get(qaAgentId)!.push(test);

    // 4) Forward to the QA agent. sendMessage uses the existing sendLocks
    //    queue, so concurrent sendQaMessage calls serialize cleanly.
    await agentService.sendMessage(qaAgentId, triggerMessage);
  },

  /** Abort the in-flight QA test for a workspace (stops the QA agent process). */
  async abortQaTest(workspaceId: string): Promise<void> {
    const ws = workspaceService.get(workspaceId);
    if (!ws) throw new Error('Workspace not found');
    if (!ws.qaAgentId) throw new Error('No QA agent provisioned');
    await agentService.stopAgent(ws.qaAgentId);
  },
};

// Subscribe to agent-idle so we can relay any pending QA report.
// Registered once at module load — HMR-safe via the listener-list dedup.
agentService.onAgentIdle(async (agentId: string) => {
  if (!pendingQaTests.has(agentId)) return;
  try {
    await processQaIdle(agentId);
  } catch (e) {
    console.error(`QA idle relay failed for ${agentId}:`, e);
  }
});

// Forget any queued tests on agent removal.
agentService.onAgentRemoved((agentId: string) => {
  const queue = pendingQaTests.get(agentId);
  if (queue) {
    for (const t of queue) if (t.hardKillTimer) clearTimeout(t.hardKillTimer);
    pendingQaTests.delete(agentId);
  }
});

// Re-export QA messages type so future tests / callers can use it.
export type { ChatMessage };
