import type { LiveDocument } from '../../shared/protocol';
import { watch, existsSync, mkdirSync, type FSWatcher } from 'fs';
import { join, basename } from 'path';
import { generateId } from '../utils';
import { persistenceService } from './persistence.service';
import { broadcast } from '../broadcast';

// HMR-safe state
const documents: Map<string, LiveDocument> = (globalThis as any).__documentsMap ??= new Map<string, LiveDocument>();
const planWriteFromServer: Set<string> = (globalThis as any).__planWriteFromServer ??= new Set<string>();
const planWatchers: Map<string, FSWatcher> = (globalThis as any).__planWatchers ??= new Map<string, FSWatcher>();

export const documentService = {
  getAll(): LiveDocument[] {
    return Array.from(documents.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  get(id: string): LiveDocument | undefined {
    return documents.get(id);
  },

  async create(
    title: string,
    content: string,
    agentId?: string,
    workspaceId?: string,
    extra?: { status?: LiveDocument['status']; lockedBy?: string; filePath?: string; lastEditedBy?: string },
  ): Promise<LiveDocument> {
    const now = Date.now();
    const doc: LiveDocument = {
      id: generateId(),
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
    documents.set(doc.id, doc);
    await persistenceService.saveNow();
    return doc;
  },

  async update(
    id: string,
    updates: { title?: string; content?: string; agentId?: string | null; lastEditedBy?: string; workspaceId?: string | null; status?: LiveDocument['status']; lockedBy?: string | null; filePath?: string },
  ): Promise<LiveDocument | null> {
    const doc = documents.get(id);
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
    await persistenceService.saveNow();

    // Sync content changes back to .plans/ file on disk so agents can read them
    if (updates.content !== undefined && doc.filePath) {
      try {
        planWriteFromServer.add(doc.filePath);
        await Bun.write(doc.filePath, doc.content);
        setTimeout(() => planWriteFromServer.delete(doc.filePath!), 500);
      } catch (e) {
        console.error(`Failed to sync document to ${doc.filePath}:`, e);
        planWriteFromServer.delete(doc.filePath);
      }
    }
    return doc;
  },

  async delete(id: string): Promise<boolean> {
    const deleted = documents.delete(id);
    if (deleted) await persistenceService.saveNow();
    return deleted;
  },

  // --- Plan interception & sync ---

  async handlePlanWrite(agentId: string, agentName: string, isRunning: boolean, workspaceId: string | undefined, filePath: string, content: string): Promise<void> {
    const filename = basename(filePath, '.md');
    const title = filename.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    let existingDoc: LiveDocument | undefined;
    for (const doc of documents.values()) {
      if (doc.filePath === filePath) { existingDoc = doc; break; }
    }
    if (!existingDoc) {
      for (const doc of documents.values()) {
        if (doc.title === title && doc.agentId === agentId) { existingDoc = doc; break; }
      }
    }

    if (existingDoc) {
      existingDoc.content = content;
      existingDoc.filePath = filePath;
      if (isRunning) {
        existingDoc.lastEditedBy = agentName;
        existingDoc.lockedBy = agentId;
        existingDoc.status = 'in_progress';
      }
      existingDoc.updatedAt = Date.now();
      await persistenceService.saveNow();
      broadcast({ type: 'document_updated', document: existingDoc });
    } else {
      const doc = await documentService.create(title, content, agentId, workspaceId, {
        status: isRunning ? 'in_progress' : 'draft',
        lockedBy: isRunning ? agentId : undefined,
        filePath,
        lastEditedBy: isRunning ? agentName : 'user',
      });
      broadcast({ type: 'document_updated', document: doc });
    }
  },

  async syncPlanFromFile(agentId: string, agentName: string, isRunning: boolean, workspaceId: string | undefined, filePath: string): Promise<void> {
    if (planWriteFromServer.has(filePath)) return;
    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const content = await file.text();
        await documentService.handlePlanWrite(agentId, agentName, isRunning, workspaceId, filePath, content);
      }
    } catch (e) {
      console.error(`Failed to sync plan from file ${filePath}:`, e);
    }
  },

  async releaseLocksForAgent(agentId: string): Promise<void> {
    for (const doc of documents.values()) {
      if (doc.lockedBy === agentId) {
        doc.lockedBy = undefined;
        if (doc.status === 'in_progress') doc.status = 'draft';
        doc.updatedAt = Date.now();
        broadcast({ type: 'document_updated', document: doc });
      }
    }
    await persistenceService.saveNow();
  },

  /** Build documents context string for agent prompts */
  getDocumentsForAgent(agentId: string, agentWorkspaceId: string | undefined): string {
    const allDocs = Array.from(documents.values());
    const relevant = allDocs.filter(d =>
      (!d.workspaceId && !d.agentId) ||
      (agentWorkspaceId && d.workspaceId === agentWorkspaceId) ||
      d.agentId === agentId
    );
    if (relevant.length === 0) return '';
    const statusTag = (s: string) => s === 'approved' ? '[APPROVED]' : s === 'in_progress' ? '[IN PROGRESS]' : '[DRAFT]';
    const docText = relevant.map(d => {
      if (d.filePath) {
        return `- ${d.title} ${statusTag(d.status)} → file: ${d.filePath}`;
      }
      const maxInline = 2000;
      const content = d.content.length > maxInline
        ? d.content.slice(0, maxInline) + '\n...(truncated — full content available in Plans sidebar)'
        : d.content;
      return `--- Plan: ${d.title} ${statusTag(d.status)} ---\n${content}\n--- End ---`;
    }).join('\n');
    return `Plans (read the file path for full content when you need to reference a plan):\n${docText}`;
  },

  // --- Plans file watcher ---

  startPlansWatcher(agentId: string, cwd: string): void {
    const plansDir = join(cwd, '.plans');
    if (!existsSync(plansDir)) return;

    // Clean up existing watcher
    const existing = planWatchers.get(agentId);
    if (existing) {
      existing.close();
      planWatchers.delete(agentId);
    }

    try {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      const changedFiles = new Set<string>();

      const watcher = watch(plansDir, (eventType, filename) => {
        if (!filename || !filename.endsWith('.md')) return;
        changedFiles.add(filename);
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          for (const fn of changedFiles) {
            const fp = join(plansDir, fn);
            // We need agent info at call time — use a generic approach
            // The caller should handle this via the agent service
            documentService._onPlanFileChanged?.(agentId, fp);
          }
          changedFiles.clear();
        }, 300);
      });
      planWatchers.set(agentId, watcher);
    } catch (e) {
      console.error(`Plans watcher failed for agent ${agentId}:`, e);
    }
  },

  stopPlansWatcher(agentId: string): void {
    const existing = planWatchers.get(agentId);
    if (existing) {
      existing.close();
      planWatchers.delete(agentId);
    }
  },

  /** Callback set by agent service for plan file changes */
  _onPlanFileChanged: null as ((agentId: string, filePath: string) => void) | null,

  /** Load documents from persisted data */
  load(docsList: LiveDocument[] | undefined) {
    if (docsList) {
      for (const doc of docsList) {
        if (!(doc as any).status) (doc as any).status = 'draft';
        delete (doc as any).lockedBy; // Clear stale locks on startup
        documents.set(doc.id, doc);
      }
    }
  },
};
