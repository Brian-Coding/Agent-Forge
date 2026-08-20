// The Plans sidebar UI was removed (2026-07-09). This service survives as the
// agent-facing `.plans/` plumbing only: plan-file watching/sniffing, prompt
// context assembly, and per-agent write locks. Nothing here reaches the client
// anymore — document records exist purely server-side (persisted in data.json).
import type { LiveDocument } from '../../shared/protocol';
import { watch, existsSync, mkdirSync, type FSWatcher } from 'fs';
import { join, basename } from 'path';
import { generateId } from '../utils';
import { persistenceService } from './persistence.service';
import { runDurableMutation } from './durable-mutation';

// HMR-safe state
const documents: Map<string, LiveDocument> = (globalThis as any).__documentsMap ??= new Map<string, LiveDocument>();
const planWriteFromServer: Set<string> = (globalThis as any).__planWriteFromServer ??= new Set<string>();
const planWatchers: Map<string, FSWatcher> = (globalThis as any).__planWatchers ??= new Map<string, FSWatcher>();

type DocumentExtra = { status?: LiveDocument['status']; lockedBy?: string; filePath?: string; lastEditedBy?: string };

function buildDocument(
  title: string,
  content: string,
  agentId?: string,
  workspaceId?: string,
  extra?: DocumentExtra,
): LiveDocument {
  const now = Date.now();
  return {
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
}

function restoreDocument(target: LiveDocument, snapshot: LiveDocument): void {
  for (const key of Object.keys(target) as Array<keyof LiveDocument>) delete (target as any)[key];
  Object.assign(target, snapshot);
}

export const documentService = {
  getAll(): LiveDocument[] {
    return Array.from(documents.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async create(
    title: string,
    content: string,
    agentId?: string,
    workspaceId?: string,
    extra?: DocumentExtra,
  ): Promise<LiveDocument> {
    return runDurableMutation(async () => {
      const doc = buildDocument(title, content, agentId, workspaceId, extra);
      documents.set(doc.id, doc);
      try {
        await persistenceService.saveNow();
        return doc;
      } catch (error) {
        documents.delete(doc.id);
        throw error;
      }
    });
  },

  // --- Plan interception & sync ---

  async handlePlanWrite(agentId: string, agentName: string, isRunning: boolean, workspaceId: string | undefined, filePath: string, content: string): Promise<void> {
    return runDurableMutation(async () => {
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
        const previous = structuredClone(existingDoc);
        existingDoc.content = content;
        existingDoc.filePath = filePath;
        if (isRunning) {
          existingDoc.lastEditedBy = agentName;
          existingDoc.lockedBy = agentId;
          existingDoc.status = 'in_progress';
        }
        existingDoc.updatedAt = Date.now();
        try {
          await persistenceService.saveNow();
        } catch (error) {
          restoreDocument(existingDoc, previous);
          throw error;
        }
        return;
      }

      const doc = buildDocument(title, content, agentId, workspaceId, {
        status: isRunning ? 'in_progress' : 'draft',
        lockedBy: isRunning ? agentId : undefined,
        filePath,
        lastEditedBy: isRunning ? agentName : 'user',
      });
      documents.set(doc.id, doc);
      try {
        await persistenceService.saveNow();
      } catch (error) {
        documents.delete(doc.id);
        throw error;
      }
    });
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
    return runDurableMutation(async () => {
      const changed = new Map<LiveDocument, LiveDocument>();
      for (const doc of documents.values()) {
        if (doc.lockedBy === agentId) {
          changed.set(doc, structuredClone(doc));
          doc.lockedBy = undefined;
          if (doc.status === 'in_progress') doc.status = 'draft';
          doc.updatedAt = Date.now();
        }
      }
      try {
        await persistenceService.saveNow();
      } catch (error) {
        for (const [doc, snapshot] of changed) restoreDocument(doc, snapshot);
        throw error;
      }
    });
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
        ? d.content.slice(0, maxInline) + '\n...(truncated — read the .plans/ file for full content)'
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
