// The Plans sidebar UI was removed (2026-07-09). This service survives as the
// agent-facing `.plans/` plumbing only: plan-file watching/sniffing, prompt
// context assembly, and per-agent write locks. Nothing here reaches the client
// anymore. Source-controlled `.plans/*.md` files are canonical; only legacy
// inline documents and missing-source recovery records remain in data.json.
import type { LiveDocument } from '../../shared/protocol';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, normalize, resolve } from 'path';
import { projectWatcherHub } from './project-watcher.service';
import { generateId } from '../utils';
import { persistenceService } from './persistence.service';
import { runDurableMutation } from './durable-mutation';

// HMR-safe state
const documents: Map<string, LiveDocument> = (globalThis as any).__documentsMap ??= new Map<string, LiveDocument>();

type DocumentExtra = { status?: LiveDocument['status']; lockedBy?: string; filePath?: string; lastEditedBy?: string };

export type PlanLifecycle = LiveDocument['status'] | 'paused' | 'completed' | 'superseded' | 'reference';

export interface PlanReference {
  title: string;
  status: PlanLifecycle;
  filePath: string;
}

const ACTIVE_PLAN_STATUSES = new Set<PlanLifecycle>(['draft', 'approved', 'in_progress']);

function statusFromText(text: string): PlanLifecycle | null {
  const normalizedText = text
    .replace(/[\[\]*_>`#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!normalizedText) return null;
  if (/\b(in progress|implementation in progress|activation smoke pending|acceptance pending)\b/.test(normalizedText)) return 'in_progress';
  if (/\b(paused|on hold)\b/.test(normalizedText)) return 'paused';
  if (/\b(superseded|obsolete)\b/.test(normalizedText)) return 'superseded';
  if (/\b(completed|complete|executed|implemented)\b/.test(normalizedText)) return 'completed';
  if (/\b(reference|historical)\b/.test(normalizedText)) return 'reference';
  if (/\bapproved\b/.test(normalizedText)) return 'approved';
  if (/\bdraft\b/.test(normalizedText)) return 'draft';
  return null;
}

/** Derive lifecycle from the Markdown itself instead of stale runtime locks. */
export function parsePlanLifecycle(content: string): PlanLifecycle {
  const lines = content.replace(/\r\n/g, '\n').split('\n').slice(0, 24);
  const lifecycle = lines.find(line => /\blifecycle\s*:/i.test(line));
  if (lifecycle) return statusFromText(lifecycle) ?? 'draft';
  const status = lines.find(line => /\b(?:document\s+)?status\s*:/i.test(line));
  if (status) return statusFromText(status) ?? 'draft';
  return statusFromText(lines[0] ?? '') ?? 'draft';
}

export function canonicalPlanPath(filePath: string): string {
  const absolute = normalize(resolve(filePath));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function planTitle(filename: string, content: string): string {
  const heading = content.replace(/\r\n/g, '\n').split('\n').find(line => /^#\s+\S/.test(line));
  if (heading) {
    const cleaned = heading
      .replace(/^#\s+/, '')
      .replace(/\s*\[(?:draft|approved|in progress|paused|completed|executed|implemented|superseded|reference)[^\]]*\]\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned) return cleaned;
  }
  return basename(filename, '.md').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Read the current top-level `.plans/*.md` catalog directly from disk. */
export function discoverPlanReferences(cwd: string): PlanReference[] {
  const plansDir = resolve(cwd, '.plans');
  try {
    const plans: PlanReference[] = [];
    for (const entry of readdirSync(plansDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      try {
        const filePath = resolve(plansDir, entry.name);
        const content = readFileSync(filePath, 'utf8');
        plans.push({ title: planTitle(entry.name, content), status: parsePlanLifecycle(content), filePath });
      } catch {
        // A transiently unreadable historical file must not hide every other
        // active plan from the prompt. The lifecycle index remains discoverable.
      }
    }
    return plans.sort((a, b) => a.filePath.localeCompare(b.filePath));
  } catch {
    return [];
  }
}

function statusTag(status: PlanLifecycle): string {
  const labels: Record<PlanLifecycle, string> = {
    draft: 'DRAFT',
    approved: 'APPROVED',
    in_progress: 'IN PROGRESS',
    paused: 'PAUSED',
    completed: 'COMPLETED',
    superseded: 'SUPERSEDED',
    reference: 'REFERENCE',
  };
  return `[${labels[status]}]`;
}

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

  /**
   * File-backed plans are source-controlled and reconstructed from `.plans/`.
   * Persist only inline legacy documents and file records whose source is gone,
   * so a stale record is never the only remaining copy of its content.
   */
  buildPersistedDocuments(): LiveDocument[] {
    return documentService.getAll().filter(doc => !doc.filePath || !existsSync(doc.filePath));
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
      filePath = normalize(resolve(filePath));
      const filename = basename(filePath, '.md');
      const title = filename.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

      let existingDoc: LiveDocument | undefined;
      for (const doc of documents.values()) {
        if (doc.filePath && canonicalPlanPath(doc.filePath) === canonicalPlanPath(filePath)) { existingDoc = doc; break; }
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
        } else existingDoc.status = parsePlanLifecycle(content) === 'approved' ? 'approved' : 'draft';
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
        status: isRunning ? 'in_progress' : (parsePlanLifecycle(content) === 'approved' ? 'approved' : 'draft'),
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
    filePath = normalize(resolve(filePath));
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
          if (doc.status === 'in_progress') {
            const lifecycle = parsePlanLifecycle(doc.content);
            doc.status = lifecycle === 'approved' ? 'approved' : 'draft';
          }
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
  getDocumentsForAgent(agentId: string, agentWorkspaceId: string | undefined, cwd: string): string {
    const filePlans = discoverPlanReferences(cwd);
    const catalog = filePlans.find(plan => basename(plan.filePath).toLowerCase() === 'readme.md');
    const activePlans = filePlans.filter(plan => ACTIVE_PLAN_STATUSES.has(plan.status));

    // Inline documents are a legacy compatibility path. File-backed records
    // are deliberately ignored here because the live filesystem is canonical.
    const relevant = Array.from(documents.values()).filter(d => !d.filePath && (
      (!d.workspaceId && !d.agentId) ||
      (agentWorkspaceId && d.workspaceId === agentWorkspaceId) ||
      d.agentId === agentId
    ));
    if (activePlans.length === 0 && relevant.length === 0 && !catalog) return '';

    const sections: string[] = [];
    if (catalog) sections.push(`Lifecycle catalog: ${catalog.filePath}`);
    if (activePlans.length > 0) {
      sections.push(`Active or pending-review plans:\n${activePlans.map(plan => `- ${plan.title} ${statusTag(plan.status)} → file: ${plan.filePath}`).join('\n')}`);
    }
    if (relevant.length > 0) {
      const inlineText = relevant.map(d => {
        const maxInline = 2000;
        const content = d.content.length > maxInline
          ? d.content.slice(0, maxInline) + '\n...(truncated — read the .plans/ file for full content)'
          : d.content;
        return `--- Legacy inline plan: ${d.title} ${statusTag(d.status)} ---\n${content}\n--- End ---`;
      }).join('\n');
      sections.push(inlineText);
    }
    if (catalog && filePlans.some(plan => ['completed', 'superseded', 'reference'].includes(plan.status))) {
      sections.push('Paused, completed, superseded, and reference material is cataloged in the lifecycle index and is not injected as active work.');
    }
    return `Plans (read the file path for full content when you need to reference a plan):\n${sections.join('\n')}`;
  },

  // --- Plans file watcher ---

  startPlansWatcher(agentId: string, cwd: string): void {
    projectWatcherHub.subscribePlans(agentId, cwd, filePath => {
      documentService._onPlanFileChanged?.(agentId, filePath);
    });
  },

  stopPlansWatcher(agentId: string): void {
    projectWatcherHub.unsubscribePlans(agentId);
  },

  /** Callback set by agent service for plan file changes */
  _onPlanFileChanged: null as ((agentId: string, filePath: string) => void) | null,

  /** Load documents from persisted data */
  load(docsList: LiveDocument[] | undefined) {
    documents.clear();
    if (docsList) {
      for (const doc of docsList) {
        if (!(doc as any).status) (doc as any).status = 'draft';
        delete (doc as any).lockedBy; // Clear stale locks on startup
        if (doc.filePath) {
          doc.filePath = normalize(resolve(doc.filePath));
          // The source-controlled file is authoritative. A runtime record is
          // useful only as recovery material when that source disappeared.
          if (existsSync(doc.filePath)) continue;
          const duplicate = Array.from(documents.values()).find(existing =>
            existing.filePath && canonicalPlanPath(existing.filePath) === canonicalPlanPath(doc.filePath!),
          );
          if (duplicate) {
            if (doc.updatedAt > duplicate.updatedAt) {
              documents.delete(duplicate.id);
              documents.set(doc.id, doc);
            }
            continue;
          }
        }
        documents.set(doc.id, doc);
      }
    }
  },
};
