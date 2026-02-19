import type { Subprocess } from 'bun';
import { watch, mkdirSync, type FSWatcher } from 'fs';
import { existsSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import type { AgentInfo, AgentStatus, ChatMessage, PersistedData, ProjectNote, LiveDocument, AppSettings, WorkspaceInfo, TerminalSession } from '../shared/protocol';

const DATA_FILE = './data.json';
const MAX_OUTPUT_BUFFER = 2_000_000; // 2MB max output buffer per agent (agents produce more output with tools)

// Default guardrails appended to every agent — keeps them safe without user having to think about it
const DEFAULT_GUARDRAILS = `IMPORTANT GUARDRAILS — follow these at all times:
- NEVER run git commit, git push, git push --force, or git merge unless the user EXPLICITLY asks you to.
- NEVER delete branches (git branch -D/-d) unless the user EXPLICITLY asks you to.
- NEVER run destructive commands (rm -rf, git reset --hard, git checkout ., git clean) unless the user EXPLICITLY asks you to.
- Before making changes, briefly state what you plan to do and which files you'll modify.
- If you're unsure about something, ask the user rather than guessing.`;

interface ManagedAgent {
  info: AgentInfo;
  process: Subprocess<'pipe', 'pipe', 'pipe'> | null;
  sessionId: string | null; // Claude Code session ID for --resume
  outputBuffer: string;
  watcher: FSWatcher | null;
  plansWatcher: FSWatcher | null;
  lastFileChange: string[];
  // Token tracking
  contextTokens: number;      // Current context window usage (input + cached)
  contextLimit: number;       // Context window size from model
  totalInputTokens: number;   // Cumulative input tokens across all turns
  totalOutputTokens: number;  // Cumulative output tokens across all turns
  totalCostUsd: number;       // Cumulative cost
  numTurns: number;           // Number of API turns
}

type OutputCallback = (agentId: string, content: string, stream: 'stdout' | 'stderr') => void;
type StatusCallback = (agent: AgentInfo) => void;
type MessageCallback = (message: ChatMessage) => void;
type FileChangeCallback = (agentId: string, files: string[]) => void;
type ThinkingCallback = (agentId: string, content: string) => void;
type TokenUsageCallback = (agentId: string, contextTokens: number, contextLimit: number, totalInputTokens: number, totalOutputTokens: number, totalCostUsd: number, numTurns: number) => void;
type TerminalOutputCallback = (terminalId: string, content: string) => void;
type TerminalExitCallback = (terminalId: string, exitCode: number | null) => void;
type DocumentUpdatedCallback = (doc: LiveDocument) => void;

interface ManagedTerminal {
  info: TerminalSession;
  process: Subprocess<'ignore', 'pipe', 'pipe'>;
  outputBuffer: string;
}

export class AgentManager {
  private agents: Map<string, ManagedAgent> = new Map();
  private messages: Map<string, ChatMessage[]> = new Map();
  private sharedContext: string = '';
  private notes: Map<string, ProjectNote> = new Map();
  private documents: Map<string, LiveDocument> = new Map();
  private settings: AppSettings = {};
  private workspaces: Map<string, WorkspaceInfo> = new Map();
  private onOutput: OutputCallback | null = null;
  private onStatusChange: StatusCallback | null = null;
  private onMessage: MessageCallback | null = null;
  private onFileChange: FileChangeCallback | null = null;
  private onThinking: ThinkingCallback | null = null;
  private onTokenUsage: TokenUsageCallback | null = null;
  private terminals: Map<string, ManagedTerminal> = new Map();
  private onTerminalOutput: TerminalOutputCallback | null = null;
  private onTerminalExit: TerminalExitCallback | null = null;
  private onDocumentUpdated: DocumentUpdatedCallback | null = null;
  private planWriteFromServer: Set<string> = new Set(); // tracks file paths written by updateDocument to avoid watcher feedback loop

  constructor() {
    this.loadPersistedData();
  }

  setOutputCallback(cb: OutputCallback) { this.onOutput = cb; }
  setStatusCallback(cb: StatusCallback) { this.onStatusChange = cb; }
  setMessageCallback(cb: MessageCallback) { this.onMessage = cb; }
  setFileChangeCallback(cb: FileChangeCallback) { this.onFileChange = cb; }
  setThinkingCallback(cb: ThinkingCallback) { this.onThinking = cb; }
  setTokenUsageCallback(cb: TokenUsageCallback) { this.onTokenUsage = cb; }
  setTerminalOutputCallback(cb: TerminalOutputCallback) { this.onTerminalOutput = cb; }
  setTerminalExitCallback(cb: TerminalExitCallback) { this.onTerminalExit = cb; }
  setDocumentUpdatedCallback(cb: DocumentUpdatedCallback) { this.onDocumentUpdated = cb; }

  // --- Persistence ---

  private async loadPersistedData() {
    try {
      const file = Bun.file(DATA_FILE);
      if (await file.exists()) {
        const data: PersistedData = await file.json();
        for (const agent of data.agents) {
          const managed: ManagedAgent = {
            info: {
              ...agent,
              status: 'stopped',
              referencePaths: agent.referencePaths || [],
              systemPrompt: agent.systemPrompt || '',
              workspaceId: agent.workspaceId || '',
            },
            process: null,
            sessionId: (agent as any).sessionId || null,
            outputBuffer: '',
            watcher: null,
            plansWatcher: null,
            lastFileChange: [],
            contextTokens: (agent as any).contextTokens || 0,
            contextLimit: (agent as any).contextLimit || 200000,
            totalInputTokens: (agent as any).totalInputTokens || 0,
            totalOutputTokens: (agent as any).totalOutputTokens || 0,
            totalCostUsd: (agent as any).totalCostUsd || 0,
            numTurns: (agent as any).numTurns || 0,
          };
          this.agents.set(agent.id, managed);
          this.startFileWatcher(agent.id);
          this.startPlansWatcher(agent.id);
        }
        for (const msg of data.messages) {
          if (!this.messages.has(msg.agentId)) {
            this.messages.set(msg.agentId, []);
          }
          this.messages.get(msg.agentId)!.push(msg);
        }
        this.sharedContext = data.sharedContext || '';
        // Load notes
        if (data.notes) {
          for (const note of data.notes) {
            this.notes.set(note.id, note);
          }
        }
        // Load documents (with migration for new fields)
        if (data.documents) {
          for (const doc of data.documents) {
            // Migration: default status to 'draft', clear stale lockedBy
            if (!(doc as any).status) (doc as any).status = 'draft';
            delete (doc as any).lockedBy; // Clear stale locks on startup
            this.documents.set(doc.id, doc);
          }
        }
        // Load settings
        if (data.settings) {
          this.settings = data.settings;
        }
        // Load workspaces
        if (data.workspaces && data.workspaces.length > 0) {
          for (const ws of data.workspaces) {
            ws.lockedAgentIds = ws.lockedAgentIds || [];
            this.workspaces.set(ws.id, ws);
          }
        }

        // --- Migration: create "Default" workspace if none exist ---
        if (this.workspaces.size === 0) {
          const defaultId = this.generateId();
          const agentIds = Array.from(this.agents.keys());
          const defaultWorkspace: WorkspaceInfo = {
            id: defaultId,
            name: 'Default',
            gridColumns: this.settings.gridColumns || 2,
            gridRows: this.settings.gridRows || 2,
            selectedAgentIds: this.settings.selectedAgentIds || agentIds,
            lockedAgentIds: [],
            createdAt: Date.now(),
          };
          this.workspaces.set(defaultId, defaultWorkspace);
          // Assign all agents to the default workspace
          for (const managed of this.agents.values()) {
            if (!managed.info.workspaceId) {
              managed.info.workspaceId = defaultId;
            }
          }
          // Set active workspace
          this.settings.activeWorkspaceId = defaultId;
          console.log(`Migration: created "Default" workspace (${defaultId}) with ${agentIds.length} agents`);
          await this.persistData();
        }

        console.log(`Loaded ${data.agents.length} agents, ${data.messages.length} messages, ${this.notes.size} notes, ${this.documents.size} documents, ${this.workspaces.size} workspaces from disk`);
      }
    } catch (e) {
      console.error('Failed to load persisted data:', e);
    }
  }

  private async persistData() {
    const data: PersistedData = {
      agents: Array.from(this.agents.values()).map(a => ({
        ...a.info,
        sessionId: a.sessionId, // Persist session ID for resume across restarts
        contextTokens: a.contextTokens,
        contextLimit: a.contextLimit,
        totalInputTokens: a.totalInputTokens,
        totalOutputTokens: a.totalOutputTokens,
        totalCostUsd: a.totalCostUsd,
        numTurns: a.numTurns,
      })) as any,
      messages: Array.from(this.messages.values()).flat(),
      sharedContext: this.sharedContext,
      notes: Array.from(this.notes.values()),
      documents: Array.from(this.documents.values()),
      settings: this.settings,
      workspaces: Array.from(this.workspaces.values()),
    };
    await Bun.write(DATA_FILE, JSON.stringify(data, null, 2));
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 10);
  }

  // --- Getters ---

  getAgents(): AgentInfo[] {
    return Array.from(this.agents.values()).map(a => a.info);
  }

  getAgent(id: string): AgentInfo | undefined {
    return this.agents.get(id)?.info;
  }

  getMessages(agentId: string): ChatMessage[] {
    return this.messages.get(agentId) || [];
  }

  getSharedContext(): string {
    return this.sharedContext;
  }

  getTokenUsage(agentId: string): { contextTokens: number; contextLimit: number; totalInputTokens: number; totalOutputTokens: number; totalCostUsd: number; numTurns: number } | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    return {
      contextTokens: agent.contextTokens,
      contextLimit: 200000,
      totalInputTokens: agent.totalInputTokens,
      totalOutputTokens: agent.totalOutputTokens,
      totalCostUsd: agent.totalCostUsd,
      numTurns: agent.numTurns,
    };
  }

  // --- Workspace CRUD ---

  getWorkspaces(): WorkspaceInfo[] {
    return Array.from(this.workspaces.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  async createWorkspace(name: string): Promise<WorkspaceInfo> {
    const ws: WorkspaceInfo = {
      id: this.generateId(),
      name,
      gridColumns: 3,
      gridRows: 2,
      selectedAgentIds: [],
      lockedAgentIds: [],
      createdAt: Date.now(),
    };
    this.workspaces.set(ws.id, ws);
    // Set as active if it's the only one or no active set
    if (!this.settings.activeWorkspaceId || this.workspaces.size === 1) {
      this.settings.activeWorkspaceId = ws.id;
    }
    await this.persistData();
    return ws;
  }

  async updateWorkspace(id: string, updates: { name?: string; gridColumns?: number; gridRows?: number; selectedAgentIds?: string[]; lockedAgentIds?: string[] }): Promise<WorkspaceInfo | null> {
    const ws = this.workspaces.get(id);
    if (!ws) return null;
    if (updates.name !== undefined) ws.name = updates.name;
    if (updates.gridColumns !== undefined) ws.gridColumns = updates.gridColumns;
    if (updates.gridRows !== undefined) ws.gridRows = updates.gridRows;
    if (updates.selectedAgentIds !== undefined) ws.selectedAgentIds = updates.selectedAgentIds;
    if (updates.lockedAgentIds !== undefined) ws.lockedAgentIds = updates.lockedAgentIds;
    await this.persistData();
    return ws;
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    if (this.workspaces.size <= 1) return false; // Can't delete last workspace
    const ws = this.workspaces.get(id);
    if (!ws) return false;

    // Find first remaining workspace to reassign agents
    const remainingId = Array.from(this.workspaces.keys()).find(k => k !== id)!;
    const remaining = this.workspaces.get(remainingId)!;

    // Reassign agents from deleted workspace to remaining
    for (const managed of this.agents.values()) {
      if (managed.info.workspaceId === id) {
        managed.info.workspaceId = remainingId;
      }
    }

    this.workspaces.delete(id);

    // If active workspace was deleted, switch to remaining
    if (this.settings.activeWorkspaceId === id) {
      this.settings.activeWorkspaceId = remainingId;
    }

    await this.persistData();
    return true;
  }

  async setActiveWorkspace(id: string): Promise<boolean> {
    if (!this.workspaces.has(id)) return false;
    this.settings.activeWorkspaceId = id;
    await this.persistData();
    return true;
  }

  // --- Notes CRUD ---

  getNotes(): ProjectNote[] {
    return Array.from(this.notes.values());
  }

  async createNote(title: string, content: string, agentId?: string): Promise<ProjectNote> {
    const now = Date.now();
    const note: ProjectNote = {
      id: this.generateId(),
      title,
      content,
      agentId,
      createdAt: now,
      updatedAt: now,
    };
    this.notes.set(note.id, note);
    await this.persistData();
    return note;
  }

  async updateNote(id: string, updates: { title?: string; content?: string; agentId?: string | null }): Promise<ProjectNote | null> {
    const note = this.notes.get(id);
    if (!note) return null;
    if (updates.title !== undefined) note.title = updates.title;
    if (updates.content !== undefined) note.content = updates.content;
    if (updates.agentId !== undefined) note.agentId = updates.agentId || undefined;
    note.updatedAt = Date.now();
    await this.persistData();
    return note;
  }

  async deleteNote(id: string): Promise<boolean> {
    const deleted = this.notes.delete(id);
    if (deleted) await this.persistData();
    return deleted;
  }

  // --- Documents CRUD ---

  getDocuments(): LiveDocument[] {
    return Array.from(this.documents.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createDocument(title: string, content: string, agentId?: string, workspaceId?: string, extra?: { status?: LiveDocument['status']; lockedBy?: string; filePath?: string; lastEditedBy?: string }): Promise<LiveDocument> {
    const now = Date.now();
    const doc: LiveDocument = {
      id: this.generateId(),
      title,
      content,
      lastEditedBy: extra?.lastEditedBy || 'user',
      agentId,
      workspaceId,
      status: extra?.status || 'draft',
      lockedBy: extra?.lockedBy,
      filePath: extra?.filePath,
      createdAt: now,
      updatedAt: now,
    };
    this.documents.set(doc.id, doc);
    await this.persistData();
    return doc;
  }

  async updateDocument(id: string, updates: { title?: string; content?: string; agentId?: string | null; lastEditedBy?: string; workspaceId?: string | null; status?: LiveDocument['status']; lockedBy?: string | null; filePath?: string }): Promise<LiveDocument | null> {
    const doc = this.documents.get(id);
    if (!doc) return null;
    if (updates.title !== undefined) doc.title = updates.title;
    if (updates.content !== undefined) doc.content = updates.content;
    if (updates.agentId !== undefined) doc.agentId = updates.agentId || undefined;
    if (updates.workspaceId !== undefined) doc.workspaceId = updates.workspaceId || undefined;
    if (updates.lastEditedBy !== undefined) doc.lastEditedBy = updates.lastEditedBy;
    if (updates.status !== undefined) doc.status = updates.status;
    if (updates.lockedBy !== undefined) doc.lockedBy = updates.lockedBy || undefined;
    if (updates.filePath !== undefined) doc.filePath = updates.filePath;
    doc.updatedAt = Date.now();
    await this.persistData();
    // Sync content changes back to .plans/ file on disk so agents can read them
    if (updates.content !== undefined && doc.filePath) {
      try {
        this.planWriteFromServer.add(doc.filePath);
        await Bun.write(doc.filePath, doc.content);
        // Clear the guard after the watcher debounce period
        setTimeout(() => this.planWriteFromServer.delete(doc.filePath!), 500);
      } catch (e) {
        console.error(`Failed to sync document to ${doc.filePath}:`, e);
        this.planWriteFromServer.delete(doc.filePath);
      }
    }
    return doc;
  }

  async deleteDocument(id: string): Promise<boolean> {
    const deleted = this.documents.delete(id);
    if (deleted) await this.persistData();
    return deleted;
  }

  // --- Settings ---

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  async updateSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...updates };
    await this.persistData();
    return this.settings;
  }

  // --- Messages ---

  private addMessage(agentId: string, role: ChatMessage['role'], content: string, imageData?: string, imageMimeType?: string): ChatMessage {
    const msg: ChatMessage = {
      id: this.generateId(),
      agentId,
      role,
      content,
      timestamp: Date.now(),
    };
    if (imageData) msg.imageData = imageData;
    if (imageMimeType) msg.imageMimeType = imageMimeType;
    if (!this.messages.has(agentId)) {
      this.messages.set(agentId, []);
    }
    this.messages.get(agentId)!.push(msg);
    this.persistData();
    return msg;
  }

  // --- Shared Context ---

  async updateSharedContext(content: string): Promise<void> {
    this.sharedContext = content;
    await this.persistData();
  }

  // --- File Watcher ---

  private startFileWatcher(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent || !existsSync(agent.info.cwd)) return;

    // Clean up existing watcher
    if (agent.watcher) {
      agent.watcher.close();
      agent.watcher = null;
    }

    try {
      const changedFiles = new Set<string>();
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      agent.watcher = watch(agent.info.cwd, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Ignore common noise
        if (filename.includes('node_modules') || filename.includes('.git/') || filename.startsWith('.')) return;

        changedFiles.add(filename);

        // Debounce: wait 1s of quiet before notifying
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const files = Array.from(changedFiles);
          changedFiles.clear();
          agent.lastFileChange = files;
          this.onFileChange?.(agentId, files);
        }, 1000);
      });
    } catch (e) {
      // Watching not supported or directory issue — not critical
      console.error(`File watcher failed for agent ${agentId}:`, e);
    }
  }

  private stopFileWatcher(agentId: string) {
    const agent = this.agents.get(agentId);
    if (agent?.watcher) {
      agent.watcher.close();
      agent.watcher = null;
    }
  }

  // --- Build notes context for agent prompts ---

  private getNotesForAgent(agentId: string): string {
    const allNotes = Array.from(this.notes.values());
    const globalNotes = allNotes.filter(n => !n.agentId);
    const agentNotes = allNotes.filter(n => n.agentId === agentId);
    const relevant = [...globalNotes, ...agentNotes];
    if (relevant.length === 0) return '';
    const noteText = relevant.map(n => `[${n.title}]: ${n.content}`).join('\n');
    return `Project Notes:\n${noteText}`;
  }

  // --- Build documents context for agent prompts ---

  private getDocumentsForAgent(agentId: string): string {
    const agent = this.agents.get(agentId);
    const agentWorkspaceId = agent?.info.workspaceId;
    const allDocs = Array.from(this.documents.values());
    // Include docs where:
    // 1. doc is global (no workspaceId and no agentId)
    // 2. doc.workspaceId matches the agent's workspace
    // 3. doc.agentId matches this agent
    const relevant = allDocs.filter(d =>
      (!d.workspaceId && !d.agentId) ||
      (agentWorkspaceId && d.workspaceId === agentWorkspaceId) ||
      d.agentId === agentId
    );
    if (relevant.length === 0) return '';
    const statusTag = (s: string) => s === 'approved' ? '[APPROVED]' : s === 'in_progress' ? '[IN PROGRESS]' : '[DRAFT]';
    const docText = relevant.map(d => {
      const fileHint = d.filePath ? ` (file: ${d.filePath})` : '';
      return `--- Plan: ${d.title} ${statusTag(d.status)}${fileHint} ---\n${d.content}\n--- End ---`;
    }).join('\n\n');
    return `Plans (note: the user may edit plans in the sidebar — re-read the file path for the latest version if referenced):\n${docText}`;
  }

  // --- Process Management ---

  private spawnProcess(agentId: string): Subprocess<'pipe', 'pipe', 'pipe'> | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    if (agent.process) {
      agent.process.kill();
      agent.process = null;
    }

    try {
      // Build CLI args for full Claude Code agent capabilities
      const args = [
        'claude',
        '--print',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ];

      // Append to default system prompt (keeps Claude Code's built-in behavior)
      // Guardrails + per-agent persona + shared context + notes + documents + default simulator
      const appendParts: string[] = [DEFAULT_GUARDRAILS];
      if (agent.info.systemPrompt) {
        appendParts.push(`Agent Persona:\n${agent.info.systemPrompt}`);
      }
      if (this.sharedContext) {
        appendParts.push(`Project Context:\n${this.sharedContext}`);
      }
      const notesContext = this.getNotesForAgent(agentId);
      if (notesContext) {
        appendParts.push(notesContext);
      }
      const docsContext = this.getDocumentsForAgent(agentId);
      if (docsContext) {
        appendParts.push(docsContext);
      }
      // Plan management instructions
      appendParts.push(`Plan Management:
When asked to create or update a plan, use the Write tool to write a markdown file to the .plans/ directory in your working directory.
- To create a new plan: Write to .plans/<plan-name>.md
- To update an existing plan: Write the complete updated content to the same file path
- Plans will automatically appear in the user's Plans sidebar for review
- Plans marked [APPROVED] should be followed as-is
- Plans marked [DRAFT] are pending user review`);
      // Ensure .plans/ directory exists
      const plansDir = join(agent.info.cwd, '.plans');
      try { mkdirSync(plansDir, { recursive: true }); } catch {}
      // Inject default simulator if set and agent cwd looks iOS-related
      if (this.settings.defaultSimulatorUdid) {
        const cwdLower = agent.info.cwd.toLowerCase();
        const isIos = cwdLower.includes('ios') || cwdLower.includes('xcode') || cwdLower.includes('swift') || cwdLower.includes('apple');
        if (isIos || this.settings.defaultSimulatorName) {
          appendParts.push(`Default iOS Simulator: ${this.settings.defaultSimulatorName || 'Unknown'} (UDID: ${this.settings.defaultSimulatorUdid})`);
        }
      }
      // Reference directories (multi-folder support)
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

      // Session resumption — continue conversation if we have a session ID
      if (agent.sessionId) {
        args.push('--resume', agent.sessionId);
      }

      console.log(`Spawning claude for agent ${agentId}:`, args.join(' '));

      const proc = Bun.spawn(args, {
        cwd: agent.info.cwd,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      agent.process = proc;
      return proc;
    } catch (e) {
      console.error(`Failed to spawn claude for agent ${agentId}:`, e);
      return null;
    }
  }

  // Parse stream-json output from Claude CLI
  private async readStreamJson(agentId: string, proc: Subprocess<'pipe', 'pipe', 'pipe'>): Promise<string> {
    const agent = this.agents.get(agentId);
    if (!agent) return '';

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let resultText = '';
    let hasSeenText = false;

    // Also read stderr for error reporting
    this.readStderr(agentId, proc.stderr);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete JSON lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const msg = JSON.parse(line);

            if (msg.type === 'system' && msg.subtype === 'init') {
              // Capture session ID for future --resume
              if (msg.session_id && msg.session_id !== agent.sessionId) {
                agent.sessionId = msg.session_id;
                this.persistData();
                console.log(`Agent ${agentId} session: ${msg.session_id}`);
              }
            } else if (msg.type === 'assistant') {
              // Extract token usage from assistant message
              const usage = msg.message?.usage;
              if (usage) {
                // Context window usage = input_tokens + cached tokens (both read and created)
                const contextUsed = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
                if (contextUsed > 0) {
                  agent.contextTokens = contextUsed;
                  agent.totalInputTokens += contextUsed;
                }
                if (usage.output_tokens) {
                  agent.totalOutputTokens += usage.output_tokens;
                }
                this.onTokenUsage?.(agentId, agent.contextTokens, agent.contextLimit || 200000, agent.totalInputTokens, agent.totalOutputTokens, agent.totalCostUsd, agent.numTurns);
              }
              // Extract content from assistant message
              const content = msg.message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'thinking' && block.thinking) {
                    // Thinking block — set status to thinking and stream content
                    if (agent.info.status !== 'thinking') {
                      agent.info.status = 'thinking';
                      this.onStatusChange?.(agent.info);
                    }
                    this.onThinking?.(agentId, block.thinking);
                  } else if (block.type === 'text' && block.text) {
                    // First text block transitions back to working
                    if (!hasSeenText && agent.info.status === 'thinking') {
                      hasSeenText = true;
                      agent.info.status = 'working';
                      this.onStatusChange?.(agent.info);
                    }
                    resultText += block.text;
                    // Stream text to client in real-time
                    this.onOutput?.(agentId, block.text, 'stdout');
                    if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
                      agent.outputBuffer += block.text;
                    }
                  } else if (block.type === 'tool_use') {
                    // Show tool usage to the client
                    const toolInfo = `\n[Using tool: ${block.name}]\n`;
                    this.onOutput?.(agentId, toolInfo, 'stdout');
                    if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
                      agent.outputBuffer += toolInfo;
                    }
                    // Intercept Write/Edit to .plans/ directory
                    if (block.name === 'Write' && block.input?.file_path) {
                      const fp: string = block.input.file_path;
                      if (fp.includes('.plans/') || fp.includes('.plans\\')) {
                        this.handlePlanWrite(agentId, fp, block.input.content || '');
                      }
                    } else if (block.name === 'Edit' && block.input?.file_path) {
                      const fp: string = block.input.file_path;
                      if (fp.includes('.plans/') || fp.includes('.plans\\')) {
                        setTimeout(() => this.syncPlanFromFile(agentId, fp), 500);
                      }
                    }
                  }
                }
              }
            } else if (msg.type === 'result') {
              // Final result — use result text if we didn't get assistant messages
              if (!resultText && msg.result) {
                resultText = msg.result;
                this.onOutput?.(agentId, msg.result, 'stdout');
                if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
                  agent.outputBuffer += msg.result;
                }
              }

              // Capture cost, turn count, and context window from result
              if (msg.total_cost_usd) {
                agent.totalCostUsd = msg.total_cost_usd;
                console.log(`Agent ${agentId} cost: $${msg.total_cost_usd.toFixed(4)} (${msg.num_turns} turns)`);
              }
              if (msg.num_turns) {
                agent.numTurns = msg.num_turns;
              }
              // Extract context window limit from modelUsage if available
              if (msg.modelUsage) {
                for (const model of Object.values(msg.modelUsage) as any[]) {
                  if (model.contextWindow) {
                    agent.contextLimit = model.contextWindow;
                  }
                }
              }
              // Emit final usage update
              this.onTokenUsage?.(agentId, agent.contextTokens, agent.contextLimit || 200000, agent.totalInputTokens, agent.totalOutputTokens, agent.totalCostUsd, agent.numTurns);

              // Capture session ID from result too
              if (msg.session_id) {
                agent.sessionId = msg.session_id;
              }
            }
          } catch (parseErr) {
            // Not valid JSON — might be partial, stream as raw text
            this.onOutput?.(agentId, line, 'stdout');
            if (agent.outputBuffer.length < MAX_OUTPUT_BUFFER) {
              agent.outputBuffer += line;
            }
          }
        }
      }
    } catch (e) {
      // Stream closed
    }

    return resultText;
  }

  private async readStderr(agentId: string, stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.onOutput?.(agentId, text, 'stderr');
      }
    } catch (e) {
      // Stream closed
    }
  }

  // --- Plan interception & sync ---

  private async handlePlanWrite(agentId: string, filePath: string, content: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Extract title from filename: .plans/my-plan.md → "My Plan"
    const filename = basename(filePath, '.md');
    const title = filename.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    // Find existing doc by filePath or by agentId + title match
    let existingDoc: LiveDocument | undefined;
    for (const doc of this.documents.values()) {
      if (doc.filePath === filePath) { existingDoc = doc; break; }
    }
    if (!existingDoc) {
      for (const doc of this.documents.values()) {
        if (doc.title === title && doc.agentId === agentId) { existingDoc = doc; break; }
      }
    }

    // Only lock/set in_progress if the agent process is actually running
    const isAgentRunning = agent.process !== null;

    if (existingDoc) {
      existingDoc.content = content;
      existingDoc.filePath = filePath;
      if (isAgentRunning) {
        existingDoc.lastEditedBy = agent.info.name;
        existingDoc.lockedBy = agentId;
        existingDoc.status = 'in_progress';
      }
      existingDoc.updatedAt = Date.now();
      await this.persistData();
      this.onDocumentUpdated?.(existingDoc);
    } else {
      const doc = await this.createDocument(title, content, agentId, agent.info.workspaceId, {
        status: isAgentRunning ? 'in_progress' : 'draft',
        lockedBy: isAgentRunning ? agentId : undefined,
        filePath,
        lastEditedBy: isAgentRunning ? agent.info.name : 'user',
      });
      this.onDocumentUpdated?.(doc);
    }
  }

  private async syncPlanFromFile(agentId: string, filePath: string): Promise<void> {
    // Skip if this write came from updateDocument (user edit synced to disk)
    if (this.planWriteFromServer.has(filePath)) return;
    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const content = await file.text();
        await this.handlePlanWrite(agentId, filePath, content);
      }
    } catch (e) {
      console.error(`Failed to sync plan from file ${filePath}:`, e);
    }
  }

  private async releaseDocumentLocks(agentId: string): Promise<void> {
    for (const doc of this.documents.values()) {
      if (doc.lockedBy === agentId) {
        doc.lockedBy = undefined;
        if (doc.status === 'in_progress') doc.status = 'draft';
        doc.updatedAt = Date.now();
        this.onDocumentUpdated?.(doc);
      }
    }
    await this.persistData();
  }

  // --- Plans file watcher ---

  private startPlansWatcher(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent || !existsSync(agent.info.cwd)) return;

    const plansDir = join(agent.info.cwd, '.plans');
    if (!existsSync(plansDir)) return;

    // Clean up existing watcher
    if (agent.plansWatcher) {
      agent.plansWatcher.close();
      agent.plansWatcher = null;
    }

    try {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const changedFiles = new Set<string>();

      agent.plansWatcher = watch(plansDir, (eventType, filename) => {
        if (!filename || !filename.endsWith('.md')) return;

        changedFiles.add(filename);

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          for (const fn of changedFiles) {
            const fp = join(plansDir, fn);
            this.syncPlanFromFile(agentId, fp);
          }
          changedFiles.clear();
        }, 300);
      });
    } catch (e) {
      console.error(`Plans watcher failed for agent ${agentId}:`, e);
    }
  }

  private stopPlansWatcher(agentId: string) {
    const agent = this.agents.get(agentId);
    if (agent?.plansWatcher) {
      agent.plansWatcher.close();
      agent.plansWatcher = null;
    }
  }

  // --- Agent CRUD ---

  async createAgent(name: string, cwd: string, referencePaths: string[] = [], systemPrompt: string = '', workspaceId?: string): Promise<AgentInfo> {
    // Validate cwd exists
    if (!existsSync(cwd)) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }

    // Determine workspace — use provided, or active, or first available
    let wsId = workspaceId;
    if (!wsId) {
      wsId = this.settings.activeWorkspaceId;
    }
    if (!wsId || !this.workspaces.has(wsId)) {
      wsId = Array.from(this.workspaces.keys())[0];
    }
    // If still no workspace, create a default
    if (!wsId) {
      const ws = await this.createWorkspace('Default');
      wsId = ws.id;
    }

    const id = this.generateId();
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

    this.agents.set(id, {
      info,
      process: null,
      sessionId: null,
      outputBuffer: '',
      watcher: null,
      plansWatcher: null,
      lastFileChange: [],
      contextTokens: 0,
      contextLimit: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      numTurns: 0,
    });

    // Auto-add agent to workspace's selectedAgentIds if there are available slots
    const ws = this.workspaces.get(wsId);
    if (ws) {
      const totalSlots = ws.gridColumns * ws.gridRows;
      if (ws.selectedAgentIds.length < totalSlots) {
        ws.selectedAgentIds.push(id);
      }
    }

    this.startFileWatcher(id);
    this.startPlansWatcher(id);
    await this.persistData();
    return this.agents.get(id)!.info;
  }

  async removeAgent(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    // Kill process and stop watchers
    if (agent.process) {
      agent.process.kill();
    }
    this.stopFileWatcher(agentId);
    this.stopPlansWatcher(agentId);
    await this.releaseDocumentLocks(agentId);

    // Remove agent from all workspace selectedAgentIds and lockedAgentIds
    for (const ws of this.workspaces.values()) {
      ws.selectedAgentIds = ws.selectedAgentIds.filter(id => id !== agentId);
      ws.lockedAgentIds = ws.lockedAgentIds.filter(id => id !== agentId);
    }

    this.agents.delete(agentId);
    this.messages.delete(agentId);
    await this.persistData();
    return true;
  }

  async updateAgent(agentId: string, updates: { name?: string; cwd?: string; referencePaths?: string[]; systemPrompt?: string }): Promise<AgentInfo | null> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    // Validate new cwd if provided
    if (updates.cwd !== undefined) {
      if (!existsSync(updates.cwd)) {
        throw new Error(`Working directory does not exist: ${updates.cwd}`);
      }
      const cwdChanged = updates.cwd !== agent.info.cwd;
      agent.info.cwd = updates.cwd;
      // Restart file watcher if cwd changes
      if (cwdChanged) {
        this.stopFileWatcher(agentId);
        this.startFileWatcher(agentId);
      }
    }

    if (updates.name !== undefined) agent.info.name = updates.name;
    if (updates.referencePaths !== undefined) agent.info.referencePaths = updates.referencePaths;
    if (updates.systemPrompt !== undefined) agent.info.systemPrompt = updates.systemPrompt;

    await this.persistData();
    return agent.info;
  }

  async clearHistory(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    this.messages.set(agentId, []);
    // Also clear session ID so next message starts fresh
    agent.sessionId = null;
    await this.persistData();
    return true;
  }

  // --- Agent Control ---

  async stopAgent(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    if (agent.process) {
      agent.process.kill();
      agent.process = null;
    }

    // Save whatever output was collected so far
    if (agent.outputBuffer.trim()) {
      const partialMsg = this.addMessage(agentId, 'assistant', agent.outputBuffer.trim() + '\n\n[Stopped by user]');
      this.onMessage?.(partialMsg);
      agent.outputBuffer = '';
    }

    await this.releaseDocumentLocks(agentId);
    agent.info.status = 'idle';
    this.onStatusChange?.(agent.info);
    return true;
  }

  async killAgent(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    if (agent.process) {
      agent.process.kill();
      agent.process = null;
    }

    await this.releaseDocumentLocks(agentId);
    agent.info.status = 'stopped';
    this.onStatusChange?.(agent.info);
    await this.persistData();
    return true;
  }

  // --- Messaging ---

  async sendMessage(agentId: string, content: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Add and broadcast user message immediately
    const userMsg = this.addMessage(agentId, 'user', content);
    this.onMessage?.(userMsg);

    // Set working BEFORE spawn
    agent.outputBuffer = '';
    agent.info.status = 'working';
    this.onStatusChange?.(agent.info);

    const proc = this.spawnProcess(agentId);

    if (!proc) {
      const errMsg = existsSync(agent.info.cwd)
        ? 'Failed to start Claude Code process. Is the `claude` CLI installed?'
        : `Working directory does not exist: ${agent.info.cwd}`;
      const sysMsg = this.addMessage(agentId, 'system', errMsg);
      this.onMessage?.(sysMsg);
      agent.info.status = 'error';
      this.onStatusChange?.(agent.info);
      return;
    }

    try {
      // Send the user's message via stdin
      proc.stdin.write(content + '\n');
      proc.stdin.end();

      // Read stream-json output (captures session ID, streams text, parses tool use)
      const readPromise = this.readStreamJson(agentId, proc);

      // Wait for process to complete (no timeout — user can stop manually)
      const exitCode = await proc.exited;

      // Wait for stream reading to complete
      await readPromise;

      // Save and broadcast the assistant response
      if (agent.outputBuffer.trim()) {
        const assistantMsg = this.addMessage(agentId, 'assistant', agent.outputBuffer.trim());
        this.onMessage?.(assistantMsg);
      }

      await this.releaseDocumentLocks(agentId);
      agent.process = null;
      agent.info.status = exitCode === 0 ? 'idle' : 'error';
      this.onStatusChange?.(agent.info);
      await this.persistData(); // Persist session ID
    } catch (e) {
      console.error(`Error sending message to agent ${agentId}:`, e);
      agent.process = null;
      agent.info.status = 'error';
      this.onStatusChange?.(agent.info);
    }
  }

  // --- Terminal Management ---

  getTerminals(): TerminalSession[] {
    return Array.from(this.terminals.values()).map(t => t.info);
  }

  async createTerminal(agentId: string, command: string): Promise<TerminalSession> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    const id = this.generateId();
    const info: TerminalSession = {
      id,
      agentId,
      command,
      cwd: agent.info.cwd,
      status: 'running',
      createdAt: Date.now(),
    };

    try {
      const proc = Bun.spawn(['sh', '-c', command], {
        cwd: agent.info.cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const managed: ManagedTerminal = { info, process: proc, outputBuffer: '' };
      this.terminals.set(id, managed);

      // Stream stdout
      const readStream = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            managed.outputBuffer += text;
            if (managed.outputBuffer.length > MAX_OUTPUT_BUFFER) {
              managed.outputBuffer = managed.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
            }
            this.onTerminalOutput?.(id, text);
          }
        } catch {}
      };

      readStream(proc.stdout);
      readStream(proc.stderr);

      // Handle exit
      proc.exited.then((exitCode) => {
        managed.info.status = 'stopped';
        this.onTerminalExit?.(id, exitCode);
      });

      return info;
    } catch (e: any) {
      throw new Error('Failed to spawn terminal: ' + (e.message || 'unknown error'));
    }
  }

  async killTerminal(id: string): Promise<boolean> {
    const terminal = this.terminals.get(id);
    if (!terminal) return false;
    try {
      terminal.process.kill();
    } catch {}
    terminal.info.status = 'stopped';
    this.terminals.delete(id);
    return true;
  }

  // --- Image handling ---

  async sendImage(agentId: string, imageData: string, mimeType: string, prompt?: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Determine file extension from mime type
    const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/gif' ? '.gif' : mimeType === 'image/webp' ? '.webp' : '.png';

    // Save image to system temp dir so it doesn't pollute the git working tree
    const filename = `screenshot_${Date.now()}${ext}`;
    const filepath = join(tmpdir(), filename);

    try {
      const buffer = Buffer.from(imageData, 'base64');
      await Bun.write(filepath, buffer);

      // Add image message to chat history
      const imgMsg = this.addMessage(agentId, 'user', `[Image uploaded: ${filename}]` + (prompt ? '\n' + prompt : ''), imageData, mimeType);
      this.onMessage?.(imgMsg);

      // Send a message to the agent referencing the image file via absolute path (outside repo)
      const content = prompt
        ? `I've uploaded a screenshot/image for you to examine: ${filepath}\n\n${prompt}`
        : `I've uploaded a screenshot/image for you to examine: ${filepath}\nPlease examine this image file and describe what you see or act on it as appropriate.`;
      await this.sendMessage(agentId, content);
    } catch (e) {
      console.error(`Failed to save image for agent ${agentId}:`, e);
      const errMsg = this.addMessage(agentId, 'system', 'Failed to process uploaded image.');
      this.onMessage?.(errMsg);
    }
  }
}

export const agentManager = new AgentManager();
