import type { WorkspaceInfo, AppSettings, AtlasRunInfo, QaRunInfo } from '../../shared/protocol';
import { generateId } from '../utils';
import { persistenceService } from './persistence.service';
import { settingsService } from './settings.service';
import { compactQaRunHistory } from './qa-run-history';

// HMR-safe state
const workspaces: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap ??= new Map<string, WorkspaceInfo>();

export function sortWorkspaces(items: readonly WorkspaceInfo[]): WorkspaceInfo[] {
  return [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
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

  async create(name: string): Promise<WorkspaceInfo> {
    const existingOrders = Array.from(workspaces.values(), workspace => workspace.sortOrder)
      .filter(Number.isFinite);
    const nextSortOrder = existingOrders.length === 0 ? 0 : Math.max(...existingOrders) + 1;
    const ws: WorkspaceInfo = {
      id: generateId(),
      name,
      sortOrder: nextSortOrder,
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

  async update(id: string, updates: { name?: string; gridColumns?: number; gridRows?: number; selectedAgentIds?: string[]; lockedAgentIds?: string[]; testUrl?: string; qaAgentId?: string | null; qaRuns?: QaRunInfo[]; atlasAgentId?: string | null; atlasProjectCwd?: string; atlasLastScanAt?: number; atlasRun?: AtlasRunInfo | null; qaSurfaceVerifications?: Record<string, number> }): Promise<WorkspaceInfo | null> {
    const ws = workspaces.get(id);
    if (!ws) return null;
    if (updates.name !== undefined) ws.name = updates.name;
    if (updates.gridColumns !== undefined) ws.gridColumns = updates.gridColumns;
    if (updates.gridRows !== undefined) ws.gridRows = updates.gridRows;
    if (updates.selectedAgentIds !== undefined) ws.selectedAgentIds = updates.selectedAgentIds;
    if (updates.lockedAgentIds !== undefined) ws.lockedAgentIds = updates.lockedAgentIds;
    if (updates.testUrl !== undefined) ws.testUrl = updates.testUrl;
    if (updates.qaAgentId !== undefined) {
      if (updates.qaAgentId === null) delete ws.qaAgentId;
      else ws.qaAgentId = updates.qaAgentId;
    }
    if (updates.qaRuns !== undefined) ws.qaRuns = updates.qaRuns;
    if (updates.atlasAgentId !== undefined) {
      if (updates.atlasAgentId === null) delete ws.atlasAgentId;
      else ws.atlasAgentId = updates.atlasAgentId;
    }
    if (updates.atlasProjectCwd !== undefined) ws.atlasProjectCwd = updates.atlasProjectCwd;
    if (updates.atlasLastScanAt !== undefined) ws.atlasLastScanAt = updates.atlasLastScanAt;
    if (updates.atlasRun !== undefined) {
      if (updates.atlasRun === null) delete ws.atlasRun;
      else ws.atlasRun = updates.atlasRun;
    }
    if (updates.qaSurfaceVerifications !== undefined) ws.qaSurfaceVerifications = updates.qaSurfaceVerifications;
    await persistenceService.saveNow();
    return ws;
  },

  async reorder(orderedIds: readonly string[]): Promise<WorkspaceInfo[]> {
    const current = workspaceService.getAll();
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
    await persistenceService.saveNow();
    return ordered;
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
      for (const [index, ws] of workspacesList.entries()) {
        if (!Number.isFinite(ws.sortOrder)) ws.sortOrder = index;
        ws.lockedAgentIds = ws.lockedAgentIds || [];
        ws.qaRuns = Array.isArray(ws.qaRuns) ? ws.qaRuns : [];
        ws.qaRuns = compactQaRunHistory(ws.qaRuns.map(run => {
          const interruptedHandoff = !!run.handoffStartedAt && !run.handedOffAt;
          if (run.status !== 'queued' && run.status !== 'running') {
            return interruptedHandoff
              ? { ...run, handoffStartedAt: undefined, handoffError: 'Agent Forge restarted before the QA handoff completed. Try sending it again.' }
              : run;
          }
          return {
            ...run,
            status: 'failed',
            verdict: 'inconclusive',
            summary: 'Agent Forge restarted before this QA run completed.',
            report: '⚪ INCONCLUSIVE — Agent Forge restarted before this QA run completed.',
            validationErrors: ['Interrupted by server restart'],
            finishedAt: Date.now(),
            error: 'Interrupted by server restart; run it again to obtain a trustworthy result.',
            handoffStartedAt: undefined,
            handoffError: interruptedHandoff ? 'Agent Forge restarted before the QA handoff completed. Try sending it again.' : run.handoffError,
          };
        }), 30);
        // An in-flight process cannot survive a server restart. Keep its
        // candidate and surface a resumable state instead of pretending the
        // scan completed or silently starting it over.
        if (ws.atlasRun?.status === 'running' || ws.atlasRun?.status === 'validating') {
          ws.atlasRun = {
            ...ws.atlasRun,
            status: 'paused',
            finishedAt: Date.now(),
            error: 'Agent Forge restarted before this Atlas run completed. Resume to continue from its candidate checkpoint.',
          };
        }

        // One-time compatibility import for Atlases created before manifests
        // existed. Never advance an existing timestamp from file mtime: only a
        // validated candidate promotion may mark a new scan complete.
        if (ws.atlasProjectCwd) {
          const atlasMd = join(ws.atlasProjectCwd, 'docs', 'ui-atlas', 'atlas.md');
          if (existsSync(atlasMd) && !ws.atlasLastScanAt) {
            try {
              const mtime = statSync(atlasMd).mtimeMs;
              ws.atlasLastScanAt = mtime;
              console.log(`[workspace] imported legacy atlas timestamp for ${ws.name}`);
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
        sortOrder: 0,
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
