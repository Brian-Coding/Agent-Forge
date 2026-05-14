import { watch, existsSync, mkdirSync, type FSWatcher } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AgentInfo, AgentProvider, AgentStatus, ChatMessage } from '../../shared/protocol';
import { generateId } from '../utils';
import { persistenceService } from './persistence.service';
import { noteService } from './note.service';
import { documentService } from './document.service';
import { workspaceService } from './workspace.service';
import { settingsService } from './settings.service';
import { broadcast } from '../broadcast';

// MAX_OUTPUT_BUFFER, DEFAULT_GUARDRAILS, readWithTimeout, and the Claude-specific
// spawn/parse code (spawnProcess, readStreamJson, readStderr, _sendMessageImpl)
// were removed in Phase 1D. Claude-specific logic now lives in:
//   src/server/agents/adapters/claude.ts          (Phase 2)
//   src/server/services/chat.service.ts           (bridge — Phase 1 stub)
//   src/server/services/prompt-builder.service.ts (system-prompt assembly)

interface ManagedAgent {
  info: AgentInfo;
  /**
   * Per-provider session pool. Switching provider preserves both threads —
   * `sessionIds.claude` keeps Claude's resume token, `sessionIds.codex` keeps
   * Codex's. Only "Clear History" wipes both.
   */
  sessionIds: Partial<Record<AgentProvider, string>>;
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

// --- Lifecycle bus ---
// Other services (qa.service, atlas.service) subscribe to agent transitions
// without agent.service needing to import them. Registrations happen at
// each subscriber's module-load time. HMR-safe via globalThis so reloads
// don't double-register or lose listeners. Listeners run sequentially and
// their throws are caught + logged so one bad listener can't block others.
type AgentLifecycleListener = (agentId: string) => void | Promise<void>;
const lifecycleListeners: {
  onIdle: AgentLifecycleListener[];
  onStop: AgentLifecycleListener[];
  onRemoved: AgentLifecycleListener[];
} = (globalThis as any).__agentLifecycleListeners ??= { onIdle: [], onStop: [], onRemoved: [] };

async function notifyLifecycle(kind: 'onIdle' | 'onStop' | 'onRemoved', agentId: string): Promise<void> {
  for (const listener of lifecycleListeners[kind]) {
    try { await listener(agentId); } catch (e) { console.error(`agent lifecycle ${kind} listener failed:`, e); }
  }
}

// QA + Atlas state and system-prompt templates moved to:
//   src/server/services/qa.service.ts
//   src/server/services/atlas.service.ts
//   src/server/services/prompts/{qa,atlas}-system-prompt.ts
// They subscribe to agent lifecycle via agentService.onAgentIdle / onAgentRemoved.

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


async function _stopAgentImpl(agentId: string, reason: 'user' | 'timeout' | 'system' = 'user'): Promise<boolean> {
  const agent = agents.get(agentId);
  if (!agent) return false;

  // Ask chat.service to interrupt any in-flight adapter handle. The adapter's
  // run() resolves shortly after, and chat.service's finally block flushes any
  // accumulated partial assistant text (with the [Stopped: ...] marker baked
  // in via the abortReason we passed). Done as a dynamic import so the
  // module-load-time cycle between agent.service and chat.service stays safe.
  const { chatService } = await import('./chat.service');
  chatService.stop(agentId, reason);

  clearAgentTimeouts(agentId);
  // Note: chat.service's finally block releases plan locks + sets status to
  // 'idle' + fires onIdle hooks after the adapter unwinds. We don't repeat
  // those side effects here. If no turn is in flight, set status defensively.
  if (agent.info.status !== 'idle') {
    agent.info.status = 'idle';
    broadcast({ type: 'agent_updated', agent: agent.info });
    await documentService.releaseLocksForAgent(agentId);
    await notifyLifecycle('onIdle', agentId);
  }

  return true;
}

async function _killAgentImpl(agentId: string): Promise<boolean> {
  const agent = agents.get(agentId);
  if (!agent) return false;

  const { chatService } = await import('./chat.service');
  chatService.kill(agentId);

  clearAgentTimeouts(agentId);
  await documentService.releaseLocksForAgent(agentId);
  agent.info.status = 'stopped';
  broadcast({ type: 'agent_updated', agent: agent.info });
  await persistenceService.saveNow();
  return true;
}

export const agentService = {
  // --- Lifecycle bus ---
  // Other services (qa, atlas, and the upcoming chat.service bridge)
  // subscribe via these. Listeners persist across HMR via globalThis.
  onAgentIdle(listener: AgentLifecycleListener): void {
    if (!lifecycleListeners.onIdle.includes(listener)) lifecycleListeners.onIdle.push(listener);
  },
  onAgentStop(listener: AgentLifecycleListener): void {
    if (!lifecycleListeners.onStop.includes(listener)) lifecycleListeners.onStop.push(listener);
  },
  onAgentRemoved(listener: AgentLifecycleListener): void {
    if (!lifecycleListeners.onRemoved.includes(listener)) lifecycleListeners.onRemoved.push(listener);
  },

  // --- Getters ---

  getAgents(): AgentInfo[] {
    return Array.from(agents.values()).map(a => a.info);
  },

  /** Internal: lookup the last assistant message for a given agent. Used by qa.service relay path. */
  getLastAssistantMessage(agentId: string): ChatMessage | null {
    const msgs = messages.get(agentId) || [];
    return [...msgs].reverse().find(m => m.role === 'assistant') ?? null;
  },

  /** Internal: append a system message to an agent's chat. Used by qa.service relay path (e.g. screenshot attachments). */
  addSystemMessage(agentId: string, content: string, imageData?: string, imageMimeType?: string, source?: 'qa'): ChatMessage {
    return addMessage(agentId, 'system', content, imageData, imageMimeType, source);
  },

  /** Internal: append any-role message. Used by chat.service when broadcasting user turns. */
  appendMessage(agentId: string, role: ChatMessage['role'], content: string, imageData?: string, imageMimeType?: string, source?: 'qa'): ChatMessage {
    return addMessage(agentId, role, content, imageData, imageMimeType, source);
  },

  /** Internal: set agent status + broadcast agent_updated. No-op if status unchanged. */
  setStatus(agentId: string, status: AgentStatus): void {
    const agent = agents.get(agentId);
    if (!agent || agent.info.status === status) return;
    agent.info.status = status;
    broadcast({ type: 'agent_updated', agent: agent.info });
  },

  /** Internal: fire onIdle lifecycle hooks. Used by chat.service when an adapter run completes. */
  async notifyIdle(agentId: string): Promise<void> {
    await notifyLifecycle('onIdle', agentId);
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

  /** True if the agent is currently mid-turn (status is working or thinking). */
  isRunning(agentId: string): boolean {
    const status = agents.get(agentId)?.info.status;
    return status === 'working' || status === 'thinking';
  },

  /** Get agent name (for plan writes) */
  getAgentName(agentId: string): string {
    return agents.get(agentId)?.info.name || 'unknown';
  },

  /** Get agent workspaceId */
  getAgentWorkspaceId(agentId: string): string | undefined {
    return agents.get(agentId)?.info.workspaceId;
  },

  /**
   * Apply a usage event from the chat bridge. Snapshot fields overwrite; delta
   * fields accumulate. Returns nothing — the bridge re-reads via getTokenUsage
   * to broadcast the new snapshot.
   */
  applyUsage(agentId: string, usage: {
    contextTokens?: number;
    contextLimit?: number;
    inputTokensDelta?: number;
    outputTokensDelta?: number;
    costUsdDelta?: number;
    turnsDelta?: number;
  }): void {
    const agent = agents.get(agentId);
    if (!agent) return;
    if (typeof usage.contextTokens === 'number') agent.contextTokens = usage.contextTokens;
    if (typeof usage.contextLimit === 'number') agent.contextLimit = usage.contextLimit;
    if (typeof usage.inputTokensDelta === 'number') agent.totalInputTokens += usage.inputTokensDelta;
    if (typeof usage.outputTokensDelta === 'number') agent.totalOutputTokens += usage.outputTokensDelta;
    if (typeof usage.costUsdDelta === 'number') agent.totalCostUsd += usage.costUsdDelta;
    if (typeof usage.turnsDelta === 'number') agent.numTurns += usage.turnsDelta;
    persistenceService.save();
  },

  // --- Agent CRUD ---

  async createAgent(name: string, cwd: string, referencePaths: string[] = [], systemPrompt: string = '', workspaceId?: string, opts: { hideFromGrid?: boolean } = {}): Promise<AgentInfo> {
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

    // Auto-include the workspace's UI Atlas as a referencePath when one
    // exists, so every agent in this workspace is atlas-aware. Skip for the
    // Atlas agent itself (it owns the atlas, doesn't reference it). Skip if
    // the path already appears in the user-supplied referencePaths.
    const ws = workspaceService.get(wsId);
    const isAtlasAgent = name === 'UI Atlas Agent';
    const finalRefPaths = [...referencePaths];
    if (!isAtlasAgent && ws?.atlasProjectCwd) {
      const atlasPath = join(ws.atlasProjectCwd, 'docs', 'ui-atlas');
      if (existsSync(atlasPath) && !finalRefPaths.includes(atlasPath)) {
        finalRefPaths.unshift(atlasPath);
      }
    }

    const id = generateId();
    const info: AgentInfo = {
      id,
      name,
      cwd,
      referencePaths: finalRefPaths,
      systemPrompt,
      status: 'idle',
      createdAt: Date.now(),
      workspaceId: wsId,
    };
    if (opts.hideFromGrid) info.hideFromGrid = true;

    agents.set(id, {
      info,
      sessionIds: {},
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

    workspaceService.addAgentToWorkspace(wsId, id, opts.hideFromGrid);
    startFileWatcher(id);
    documentService.startPlansWatcher(id, cwd);
    await persistenceService.saveNow();
    return agents.get(id)!.info;
  },

  async removeAgent(agentId: string): Promise<boolean> {
    const agent = agents.get(agentId);
    if (!agent) return false;

    // Interrupt any in-flight adapter handle. The kill is fire-and-forget;
    // chat.service's normal cleanup path resolves once the subprocess dies.
    const { chatService } = await import('./chat.service');
    chatService.kill(agentId);
    chatService.resetLock(agentId);

    stopFileWatcher(agentId);
    documentService.stopPlansWatcher(agentId);
    await documentService.releaseLocksForAgent(agentId);
    workspaceService.removeAgentFromAllWorkspaces(agentId);

    agents.delete(agentId);
    messages.delete(agentId);
    await notifyLifecycle('onRemoved', agentId);
    await persistenceService.saveNow();
    return true;
  },

  async updateAgent(
    agentId: string,
    updates: {
      name?: string;
      cwd?: string;
      referencePaths?: string[];
      systemPrompt?: string;
      provider?: AgentProvider;
      model?: string;
      reasoningLevel?: string;
    },
  ): Promise<AgentInfo | null> {
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
    // Provider / model / reasoningLevel are hot-swappable per the inline
    // dropdowns under each agent's chat input. Swapping provider does NOT
    // clear sessionIds — each provider keeps its own resume token.
    if (updates.provider !== undefined) agent.info.provider = updates.provider;
    if (updates.model !== undefined) agent.info.model = updates.model;
    if (updates.reasoningLevel !== undefined) agent.info.reasoningLevel = updates.reasoningLevel;

    await persistenceService.saveNow();
    return agent.info;
  },

  async clearHistory(agentId: string): Promise<boolean> {
    const agent = agents.get(agentId);
    if (!agent) return false;
    messages.set(agentId, []);
    // Clear sessions for both providers — "Clear History" is the one path that
    // fully resets the agent's memory across the per-provider pool.
    agent.sessionIds = {};
    await persistenceService.saveNow();
    return true;
  },

  // --- Per-provider session pool (read by chat.service ctx.getSessionId / written via ctx.updateSessionId) ---

  getProviderSessionId(agentId: string, provider: AgentProvider): string | null {
    return agents.get(agentId)?.sessionIds[provider] ?? null;
  },

  setProviderSessionId(agentId: string, provider: AgentProvider, sessionId: string): void {
    const agent = agents.get(agentId);
    if (!agent) return;
    if (agent.sessionIds[provider] === sessionId) return;
    agent.sessionIds[provider] = sessionId;
    persistenceService.save();
  },

  // --- Agent Control ---

  /**
   * Delegate to chat.service so all message-sending paths (ws, qa, atlas)
   * funnel through the same bridge. chat.service owns the per-agent
   * sendLock chain now; the legacy sendLocks map here is unused but kept
   * for HMR compatibility until Phase 1D removes the legacy spawn path.
   */
  async sendMessage(agentId: string, content: string, source?: 'qa'): Promise<void> {
    // Dynamic import to avoid module-load-time circular reference. chat.service
    // imports agent.service, so the top-level import would deadlock; deferring
    // until the first call lets both modules finish loading first.
    const { chatService } = await import('./chat.service');
    return chatService.sendMessage(agentId, content, source);
  },

  async stopAgent(agentId: string, reason: 'user' | 'timeout' | 'system' = 'user'): Promise<boolean> {
    // Execute immediately — don't queue behind sendLocks.
    // Reset both lock chains (legacy + chat.service's) so queued sends after stop don't run stale.
    sendLocks.delete(agentId);
    const { chatService } = await import('./chat.service');
    chatService.resetLock(agentId);
    return _stopAgentImpl(agentId, reason);
  },

  async killAgent(agentId: string): Promise<boolean> {
    // Execute immediately — same reasoning as stopAgent.
    sendLocks.delete(agentId);
    const { chatService } = await import('./chat.service');
    chatService.resetLock(agentId);
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
        if (!img) continue;
        const ext = img.mimeType === 'image/png' ? '.png' : img.mimeType === 'image/jpeg' ? '.jpg' : img.mimeType === 'image/gif' ? '.gif' : img.mimeType === 'image/webp' ? '.webp' : '.png';
        const filename = `screenshot_${Date.now()}_${i}${ext}`;
        const filepath = join(tmpdir(), filename);
        const buffer = Buffer.from(img.imageData, 'base64');
        await Bun.write(filepath, buffer);
        filePaths.push(filepath);
      }

      // Add chat message with first image data for preview
      const first = images[0]!;
      const label = `[${images.length} image${images.length > 1 ? 's' : ''} uploaded]` + (prompt ? '\n' + prompt : '');
      const imgMsg = addMessage(agentId, 'user', label, first.imageData, first.mimeType);
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
    const { chatService } = await import('./chat.service');
    for (const agentId of agents.keys()) {
      clearAgentTimeouts(agentId);
      chatService.kill(agentId);
    }
    // Adapters own their subprocess lifetime now — the kill() calls above tell
    // each in-flight handle to terminate. PID tracking is handled inside each
    // adapter, so the persistence layer's pids.json is kept consistent without
    // any work here.
    await new Promise<void>(resolve => setTimeout(resolve, 200));
  },

  async killAllProcesses(): Promise<{ success: boolean; message: string }> {
    // "Kill All" is the emergency button — taskkill every spawned CLI by
    // image name. Currently covers Claude; once Codex is wired (Phase 3) the
    // adapter map below will grow.
    console.log('KILL ALL: Killing all claude.exe / codex.exe processes machine-wide...');
    const images = ['claude.exe', 'codex.exe'];
    try {
      if (process.platform === 'win32') {
        for (const img of images) {
          try {
            const proc = Bun.spawn(['taskkill', '/F', '/IM', img, '/T'], { stdout: 'pipe', stderr: 'pipe' });
            await proc.exited;
          } catch {
            // image not present — fine
          }
        }
      } else {
        // POSIX fallback. pkill returns non-zero if no match — ignored.
        for (const img of images) {
          try {
            const name = img.replace(/\.exe$/, '');
            const proc = Bun.spawn(['pkill', '-9', '-f', name], { stdout: 'pipe', stderr: 'pipe' });
            await proc.exited;
          } catch {}
        }
      }

      for (const agent of agents.values()) {
        agent.info.status = 'stopped';
        broadcast({ type: 'agent_updated', agent: agent.info });
        await documentService.releaseLocksForAgent(agent.info.id);
      }

      persistenceService.clearAllPids();
      await persistenceService.savePidsNow();
      await persistenceService.saveNow();

      return { success: true, message: 'All agent CLI processes killed.' };
    } catch (e: any) {
      console.error('killAllProcesses failed:', e);
      return { success: false, message: e.message || 'Failed to kill processes' };
    }
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
      // protocol.migrateAgentRecord (called by persistence.service.load) has
      // already hoisted any legacy top-level `sessionId` string into
      // `sessionIds.claude` and defaulted `provider` to 'claude'. Belt-and-
      // braces here for any record that somehow bypassed the migration.
      const sessionIds = agentData.sessionIds && typeof agentData.sessionIds === 'object'
        ? { ...agentData.sessionIds }
        : (typeof agentData.sessionId === 'string' && agentData.sessionId
            ? { claude: agentData.sessionId }
            : {});
      const managed: ManagedAgent = {
        info: {
          ...agentData,
          status: 'stopped' as AgentStatus,
          referencePaths: agentData.referencePaths || [],
          systemPrompt: agentData.systemPrompt || '',
          workspaceId: agentData.workspaceId || '',
          provider: (agentData.provider === 'claude' || agentData.provider === 'codex') ? agentData.provider : 'claude',
        },
        sessionIds,
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
      sessionIds: a.sessionIds,
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
    const isRunning = agent.info.status === 'working' || agent.info.status === 'thinking';
    documentService.syncPlanFromFile(agentId, agent.info.name, isRunning, agent.info.workspaceId, filePath);
  };
}
