import type { WorkspaceInfo, AppSettings } from '../../shared/protocol';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { generateId } from '../utils';
import { persistenceService } from './persistence.service';
import { settingsService } from './settings.service';
import { runDurableMutation } from './durable-mutation';

const LEGACY_WORKSPACE_KEYS = [
  'googleDocsTrackerEnabled',
  'qaAgentId',
  'qaRuns',
  'qaSurfaceVerifications',
  'atlasAgentId',
  'atlasProjectCwd',
  'atlasLastScanAt',
  'atlasRun',
] as const;

// HMR-safe state
const workspaces: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap ??= new Map<string, WorkspaceInfo>();

function restoreWorkspace(target: WorkspaceInfo, snapshot: WorkspaceInfo): void {
  for (const key of Object.keys(target) as Array<keyof WorkspaceInfo>) delete (target as any)[key];
  Object.assign(target, snapshot);
}

export function sortWorkspaces(items: readonly WorkspaceInfo[]): WorkspaceInfo[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
}

export async function canonicalWorkspaceDirectory(cwd: string): Promise<string> {
  const requestedCwd = cwd.trim();
  if (!requestedCwd || !isAbsolute(requestedCwd)) {
    throw new Error(`Workspace directory must be an absolute path: ${requestedCwd || '(empty)'}`);
  }
  try {
    const canonical = resolve(await realpath(requestedCwd));
    if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new Error(`Workspace directory does not exist or is not a directory: ${requestedCwd}`);
  }
}

export const workspaceService = {
  getAll(): WorkspaceInfo[] {
    return sortWorkspaces(Array.from(workspaces.values()));
  },

  get(id: string): WorkspaceInfo | undefined {
    return workspaces.get(id);
  },

  has(id: string): boolean {
    return workspaces.has(id);
  },

  size(): number {
    return workspaces.size;
  },

  keys(): IterableIterator<string> {
    return workspaces.keys();
  },

  values(): IterableIterator<WorkspaceInfo> {
    return workspaces.values();
  },

  async create(name: string, cwd: string): Promise<WorkspaceInfo> {
    const normalizedCwd = await canonicalWorkspaceDirectory(cwd);
    return runDurableMutation(async () => {
      const existingOrders = Array.from(workspaces.values(), workspace => workspace.sortOrder)
        .filter(Number.isFinite);
      const nextSortOrder = existingOrders.length === 0 ? 0 : Math.max(...existingOrders) + 1;
      const ws: WorkspaceInfo = {
        id: generateId(),
        name,
        cwd: normalizedCwd,
        sortOrder: nextSortOrder,
        gridColumns: 3,
        gridRows: 2,
        selectedAgentIds: [],
        lockedAgentIds: [],
        createdAt: Date.now(),
      };
      const settings = settingsService.getRef();
      const previousActiveWorkspaceId = settings.activeWorkspaceId;
      workspaces.set(ws.id, ws);
      if (!settings.activeWorkspaceId || workspaces.size === 1) settings.activeWorkspaceId = ws.id;
      try {
        await persistenceService.saveNow();
        return ws;
      } catch (error) {
        workspaces.delete(ws.id);
        settings.activeWorkspaceId = previousActiveWorkspaceId;
        throw error;
      }
    });
  },

  async update(id: string, updates: { name?: string; gridColumns?: number; gridRows?: number; selectedAgentIds?: string[]; lockedAgentIds?: string[]; testUrl?: string }): Promise<WorkspaceInfo | null> {
    return runDurableMutation(async () => {
      const ws = workspaces.get(id);
      if (!ws) return null;
      const previous = structuredClone(ws);
      if (updates.name !== undefined) ws.name = updates.name;
      if (updates.gridColumns !== undefined) ws.gridColumns = updates.gridColumns;
      if (updates.gridRows !== undefined) ws.gridRows = updates.gridRows;
      if (updates.selectedAgentIds !== undefined) ws.selectedAgentIds = [...updates.selectedAgentIds];
      if (updates.lockedAgentIds !== undefined) ws.lockedAgentIds = [...updates.lockedAgentIds];
      if (updates.testUrl !== undefined) ws.testUrl = updates.testUrl;
      try {
        await persistenceService.saveNow();
        return ws;
      } catch (error) {
        restoreWorkspace(ws, previous);
        throw error;
      }
    });
  },

  async reorder(orderedIds: readonly string[]): Promise<WorkspaceInfo[]> {
    return runDurableMutation(async () => {
      const current = workspaceService.getAll();
      const previousOrders = new Map(current.map(workspace => [workspace.id, workspace.sortOrder]));
      const seen = new Set<string>();
      const ordered: WorkspaceInfo[] = [];
      for (const id of orderedIds) {
        if (seen.has(id)) continue;
        const workspace = workspaces.get(id);
        if (!workspace) continue;
        seen.add(id);
        ordered.push(workspace);
      }
      for (const workspace of current) {
        if (!seen.has(workspace.id)) ordered.push(workspace);
      }
      ordered.forEach((workspace, index) => { workspace.sortOrder = index; });
      try {
        await persistenceService.saveNow();
        return ordered;
      } catch (error) {
        for (const workspace of current) workspace.sortOrder = previousOrders.get(workspace.id)!;
        throw error;
      }
    });
  },

  /** Delete workspace. Returns false if it's the last one or not found. */
  async delete(id: string, reassignAgents: (fromId: string, toId: string) => void | (() => void)): Promise<boolean> {
    return runDurableMutation(async () => {
      if (workspaces.size <= 1) return false;
      const ws = workspaces.get(id);
      if (!ws) return false;

      const remainingId = Array.from(workspaces.keys()).find(k => k !== id)!;
      const previousEntries = [...workspaces.entries()];
      const settings = settingsService.getRef();
      const previousActiveWorkspaceId = settings.activeWorkspaceId;
      let undoReassignment: (() => void) | undefined;
      try {
        const reassignmentResult = reassignAgents(id, remainingId);
        if (typeof reassignmentResult === 'function') undoReassignment = reassignmentResult;
        workspaces.delete(id);
        if (settings.activeWorkspaceId === id) settings.activeWorkspaceId = remainingId;
        await persistenceService.saveNow();
        return true;
      } catch (error) {
        workspaces.clear();
        for (const [workspaceId, workspace] of previousEntries) workspaces.set(workspaceId, workspace);
        settings.activeWorkspaceId = previousActiveWorkspaceId;
        undoReassignment?.();
        throw error;
      }
    });
  },

  async setActive(id: string): Promise<boolean> {
    return runDurableMutation(async () => {
      if (!workspaces.has(id)) return false;
      const settings = settingsService.getRef();
      const previousActiveWorkspaceId = settings.activeWorkspaceId;
      settings.activeWorkspaceId = id;
      try {
        await persistenceService.saveNow();
        return true;
      } catch (error) {
        settings.activeWorkspaceId = previousActiveWorkspaceId;
        throw error;
      }
    });
  },

  /** Add agent to workspace's selectedAgentIds in the first empty slot. */
  addAgentToWorkspace(wsId: string, agentId: string): void {
    const ws = workspaces.get(wsId);
    if (!ws) return;
    const totalSlots = ws.gridColumns * ws.gridRows;
    // Pad to totalSlots with empty strings so we can find empty slots
    while (ws.selectedAgentIds.length < totalSlots) {
      ws.selectedAgentIds.push('');
    }
    // Find first empty slot within visible grid bounds
    let emptyIdx = -1;
    for (let i = 0; i < totalSlots; i++) {
      if (!ws.selectedAgentIds[i] || ws.selectedAgentIds[i] === '') {
        emptyIdx = i;
        break;
      }
    }
    if (emptyIdx !== -1) {
      ws.selectedAgentIds[emptyIdx] = agentId;
    }
    // If no empty slot within grid, agent stays in sidebar only
  },

  /** Remove agent from all workspaces' selectedAgentIds and lockedAgentIds */
  removeAgentFromAllWorkspaces(agentId: string): void {
    for (const ws of workspaces.values()) {
      ws.selectedAgentIds = ws.selectedAgentIds.filter(id => id !== agentId);
      ws.lockedAgentIds = ws.lockedAgentIds.filter(id => id !== agentId);
    }
  },

  /** Load workspaces from persisted data, run Default workspace migration if needed */
  async loadAndMigrate(
    workspacesList: WorkspaceInfo[] | undefined,
    settings: AppSettings | undefined,
    agents: Array<{ id: string; cwd: string; workspaceId?: string }>,
    setAgentWorkspace: (agentId: string, wsId: string) => void,
  ): Promise<void> {
    let recoveryChanged = false;
    if (workspacesList && workspacesList.length > 0) {
      for (const [index, ws] of workspacesList.entries()) {
        // Defense for direct service callers: persistence already drops
        // obsolete workspace fields at its allowlist boundary.
        for (const key of LEGACY_WORKSPACE_KEYS) {
          if (key in ws) {
            delete (ws as unknown as Record<string, unknown>)[key];
            recoveryChanged = true;
          }
        }
        if (!ws.cwd) {
          const workspaceAgent = agents.find(agent => agent.workspaceId === ws.id)
            || agents.find(agent => ws.selectedAgentIds?.includes(agent.id));
          if (workspaceAgent?.cwd) {
            ws.cwd = workspaceAgent.cwd;
            recoveryChanged = true;
          }
        }
        if (!Number.isFinite(ws.sortOrder)) {
          ws.sortOrder = index;
          recoveryChanged = true;
        }
        if (!Array.isArray(ws.lockedAgentIds)) {
          ws.lockedAgentIds = [];
          recoveryChanged = true;
        }
        workspaces.set(ws.id, ws);
      }
      if (recoveryChanged) await persistenceService.saveNow();
    }

    // Migration: create "Default" workspace if none exist
    if (workspaces.size === 0) {
      const defaultId = generateId();
      const defaultWorkspace: WorkspaceInfo = {
        id: defaultId,
        name: 'Default',
        cwd: agents[0]?.cwd,
        sortOrder: 0,
        gridColumns: settings?.gridColumns || 2,
        gridRows: settings?.gridRows || 2,
        selectedAgentIds: settings?.selectedAgentIds || agents.map(agent => agent.id),
        lockedAgentIds: [],
        createdAt: Date.now(),
      };
      workspaces.set(defaultId, defaultWorkspace);

      for (const agent of agents) {
        setAgentWorkspace(agent.id, defaultId);
      }

      const settingsRef = settingsService.getRef();
      settingsRef.activeWorkspaceId = defaultId;
      console.log(`Migration: created "Default" workspace (${defaultId}) with ${agents.length} agents`);
      await persistenceService.saveNow();
    }
  },
};
