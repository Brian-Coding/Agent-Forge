import type { ProjectNote } from '../../shared/protocol';
import { generateId } from '../utils';
import { persistenceService } from './persistence.service';

// HMR-safe state
const notes: Map<string, ProjectNote> = (globalThis as any).__notesMap ??= new Map<string, ProjectNote>();

export const noteService = {
  getAll(): ProjectNote[] {
    return Array.from(notes.values());
  },

  get(id: string): ProjectNote | undefined {
    return notes.get(id);
  },

  async create(title: string, content: string, agentId?: string): Promise<ProjectNote> {
    const now = Date.now();
    const note: ProjectNote = {
      id: generateId(),
      title,
      content,
      agentId,
      createdAt: now,
      updatedAt: now,
    };
    notes.set(note.id, note);
    await persistenceService.saveNow();
    return note;
  },

  async update(id: string, updates: { title?: string; content?: string; agentId?: string | null }): Promise<ProjectNote | null> {
    const note = notes.get(id);
    if (!note) return null;
    if (updates.title !== undefined) note.title = updates.title;
    if (updates.content !== undefined) note.content = updates.content;
    if (updates.agentId !== undefined) note.agentId = updates.agentId || undefined;
    note.updatedAt = Date.now();
    await persistenceService.saveNow();
    return note;
  },

  async delete(id: string): Promise<boolean> {
    const deleted = notes.delete(id);
    if (deleted) await persistenceService.saveNow();
    return deleted;
  },

  /** Build notes context string for agent prompts */
  getNotesForAgent(agentId: string): string {
    const allNotes = Array.from(notes.values());
    const globalNotes = allNotes.filter(n => !n.agentId);
    const agentNotes = allNotes.filter(n => n.agentId === agentId);
    const relevant = [...globalNotes, ...agentNotes];
    if (relevant.length === 0) return '';
    const noteText = relevant.map(n => `[${n.title}]: ${n.content}`).join('\n');
    return `Project Notes:\n${noteText}`;
  },

  /** Load notes from persisted data */
  load(notesList: ProjectNote[] | undefined) {
    if (notesList) {
      for (const note of notesList) {
        notes.set(note.id, note);
      }
    }
  },
};
