import type { WorkspaceInfo, AppSettings } from '../../shared/protocol';
import { generateId } from '../utils';
import { persistenceService } from './persistence.service';
import { settingsService } from './settings.service';

// HMR-safe state
const workspaces: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap ??= new Map<string, WorkspaceInfo>();

export const workspaceService = {
  getAll(): WorkspaceInfo[] {
    return Array.from(workspaces.values()).sort((a, b) => a.createdAt - b.createdAt);
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

  async create(name: string): Promise<WorkspaceInfo> {
    const ws: WorkspaceInfo = {
      id: generateId(),
      name,
      gridColumns: 3,
      gridRows: 2,
      selectedAgentIds: [],
      lockedAgentIds: [],
      createdAt: Date.now(),
    };
    workspaces.set(ws.id, ws);
    const settings = settingsService.getRef();
    if (!settings.activeWorkspaceId || workspaces.size === 1) {
      settings.activeWorkspaceId = ws.id;
    }
    await persistenceService.saveNow();
    return ws;
  },

  async update(id: string, updates: { name?: string; gridColumns?: number; gridRows?: number; selectedAgentIds?: string[]; lockedAgentIds?: string[]; testUrl?: string; qaAgentId?: string; atlasAgentId?: string; atlasProjectCwd?: string; atlasLastScanAt?: number; qaSurfaceVerifications?: Record<string, number> }): Promise<WorkspaceInfo | null> {
    const ws = workspaces.get(id);
    if (!ws) return null;
    if (updates.name !== undefined) ws.name = updates.name;
    if (updates.gridColumns !== undefined) ws.gridColumns = updates.gridColumns;
    if (updates.gridRows !== undefined) ws.gridRows = updates.gridRows;
    if (updates.selectedAgentIds !== undefined) ws.selectedAgentIds = updates.selectedAgentIds;
    if (updates.lockedAgentIds !== undefined) ws.lockedAgentIds = updates.lockedAgentIds;
    if (updates.testUrl !== undefined) ws.testUrl = updates.testUrl;
    if (updates.qaAgentId !== undefined) ws.qaAgentId = updates.qaAgentId;
    if (updates.atlasAgentId !== undefined) ws.atlasAgentId = updates.atlasAgentId;
    if (updates.atlasProjectCwd !== undefined) ws.atlasProjectCwd = updates.atlasProjectCwd;
    if (updates.atlasLastScanAt !== undefined) ws.atlasLastScanAt = updates.atlasLastScanAt;
    if (updates.qaSurfaceVerifications !== undefined) ws.qaSurfaceVerifications = updates.qaSurfaceVerifications;
    await persistenceService.saveNow();
    return ws;
  },

  /** Delete workspace. Returns false if it's the last one or not found. */
  async delete(id: string, reassignAgents: (fromId: string, toId: string) => void): Promise<boolean> {
    if (workspaces.size <= 1) return false;
    const ws = workspaces.get(id);
    if (!ws) return false;

    const remainingId = Array.from(workspaces.keys()).find(k => k !== id)!;

    // Reassign agents via callback
    reassignAgents(id, remainingId);

    workspaces.delete(id);

    const settings = settingsService.getRef();
    if (settings.activeWorkspaceId === id) {
      settings.activeWorkspaceId = remainingId;
    }

    await persistenceService.saveNow();
    return true;
  },

  async setActive(id: string): Promise<boolean> {
    if (!workspaces.has(id)) return false;
    const settings = settingsService.getRef();
    settings.activeWorkspaceId = id;
    await persistenceService.saveNow();
    return true;
  },

  /**
   * Add agent to workspace's selectedAgentIds in the first empty slot.
   * If hideFromGrid is true, skip — the agent is workspace-scoped but not
   * supposed to appear in the grid (e.g. UI Atlas Agent, QA Tester).
   */
  addAgentToWorkspace(wsId: string, agentId: string, hideFromGrid?: boolean): void {
    if (hideFromGrid) return;
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
    agentIds: string[],
    setAgentWorkspace: (agentId: string, wsId: string) => void,
  ): Promise<void> {
    if (workspacesList && workspacesList.length > 0) {
      // Lazy import — workspace.service runs at boot before any node:fs use.
      const { existsSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');
      for (const ws of workspacesList) {
        ws.lockedAgentIds = ws.lockedAgentIds || [];
        // Reconcile atlasLastScanAt against atlas.md mtime. Stamps when unset
        // (user manually deleted the agent before we shipped the timestamp
        // tracking) and also bumps a stale stamp forward when the file is
        // newer (run errored / timed out after writing the atlas, leaving
        // the in-memory stamp behind on-disk reality).
        if (ws.atlasProjectCwd) {
          const atlasMd = join(ws.atlasProjectCwd, 'docs', 'ui-atlas', 'atlas.md');
          if (existsSync(atlasMd)) {
            try {
              const mtime = statSync(atlasMd).mtimeMs;
              if ((ws.atlasLastScanAt ?? 0) < mtime) {
                ws.atlasLastScanAt = mtime;
                console.log(`[workspace] reconciled atlasLastScanAt for ${ws.name} from atlas.md mtime`);
              }
            } catch {}
          }
        }
        workspaces.set(ws.id, ws);
      }
    }

    // Migration: create "Default" workspace if none exist
    if (workspaces.size === 0) {
      const defaultId = generateId();
      const defaultWorkspace: WorkspaceInfo = {
        id: defaultId,
        name: 'Default',
        gridColumns: settings?.gridColumns || 2,
        gridRows: settings?.gridRows || 2,
        selectedAgentIds: settings?.selectedAgentIds || agentIds,
        lockedAgentIds: [],
        createdAt: Date.now(),
      };
      workspaces.set(defaultId, defaultWorkspace);

      for (const agentId of agentIds) {
        setAgentWorkspace(agentId, defaultId);
      }

      const settingsRef = settingsService.getRef();
      settingsRef.activeWorkspaceId = defaultId;
      console.log(`Migration: created "Default" workspace (${defaultId}) with ${agentIds.length} agents`);
      await persistenceService.saveNow();
    }
  },
};
