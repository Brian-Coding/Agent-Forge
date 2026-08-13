import type { WorkspaceInfo, AppSettings, AtlasRunInfo, QaRunInfo } from '../../shared/protocol';
import { generateId } from '../utils';
import { persistenceService } from './persistence.service';
import { settingsService } from './settings.service';
import { compactQaRunHistory } from './qa-run-history';
import { runDurableMutation } from './durable-mutation';

// HMR-safe state
const workspaces: Map<string, WorkspaceInfo> = (globalThis as any).__workspacesMap ??= new Map<string, WorkspaceInfo>();

function restoreWorkspace(target: WorkspaceInfo, snapshot: WorkspaceInfo): void {
  for (const key of Object.keys(target) as Array<keyof WorkspaceInfo>) delete (target as any)[key];
  Object.assign(target, snapshot);
}

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
    return runDurableMutation(async () => {
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
        googleDocsTrackerEnabled: false,
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

  async update(id: string, updates: { name?: string; gridColumns?: number; gridRows?: number; selectedAgentIds?: string[]; lockedAgentIds?: string[]; testUrl?: string; googleDocsTrackerEnabled?: boolean; qaAgentId?: string | null; qaRuns?: QaRunInfo[]; atlasAgentId?: string | null; atlasProjectCwd?: string; atlasLastScanAt?: number; atlasRun?: AtlasRunInfo | null; qaSurfaceVerifications?: Record<string, number> }): Promise<WorkspaceInfo | null> {
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
      if (updates.googleDocsTrackerEnabled !== undefined) ws.googleDocsTrackerEnabled = updates.googleDocsTrackerEnabled;
      if (updates.qaAgentId !== undefined) {
        if (updates.qaAgentId === null) delete ws.qaAgentId;
        else ws.qaAgentId = updates.qaAgentId;
      }
      if (updates.qaRuns !== undefined) ws.qaRuns = structuredClone(updates.qaRuns);
      if (updates.atlasAgentId !== undefined) {
        if (updates.atlasAgentId === null) delete ws.atlasAgentId;
        else ws.atlasAgentId = updates.atlasAgentId;
      }
      if (updates.atlasProjectCwd !== undefined) ws.atlasProjectCwd = updates.atlasProjectCwd;
      if (updates.atlasLastScanAt !== undefined) ws.atlasLastScanAt = updates.atlasLastScanAt;
      if (updates.atlasRun !== undefined) {
        if (updates.atlasRun === null) delete ws.atlasRun;
        else ws.atlasRun = structuredClone(updates.atlasRun);
      }
      if (updates.qaSurfaceVerifications !== undefined) ws.qaSurfaceVerifications = { ...updates.qaSurfaceVerifications };
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
    let recoveryChanged = false;
    if (workspacesList && workspacesList.length > 0) {
      // Lazy import — workspace.service runs at boot before any node:fs use.
      const { existsSync, readFileSync, statSync } = await import('node:fs');
      const { join } = await import('node:path');
      for (const [index, ws] of workspacesList.entries()) {
        if (!Number.isFinite(ws.sortOrder)) {
          ws.sortOrder = index;
          recoveryChanged = true;
        }
        if (!Array.isArray(ws.lockedAgentIds)) {
          ws.lockedAgentIds = [];
          recoveryChanged = true;
        }
        if (!Array.isArray(ws.qaRuns)) {
          ws.qaRuns = [];
          recoveryChanged = true;
        }
        const previousQaRunCount = ws.qaRuns.length;
        ws.qaRuns = compactQaRunHistory(ws.qaRuns.map(run => {
          const interruptedHandoff = !!run.handoffStartedAt && !run.handedOffAt;
          if (run.status !== 'queued' && run.status !== 'running') {
            if (!interruptedHandoff) return run;
            recoveryChanged = true;
            return { ...run, handoffStartedAt: undefined, handoffError: 'Agent Forge restarted before the QA handoff completed. Try sending it again.' };
          }
          recoveryChanged = true;
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
        if (ws.qaRuns.length !== previousQaRunCount) recoveryChanged = true;
        // Publication is a filesystem transaction followed by state
        // persistence. If the process died between those boundaries, the
        // canonical manifest is the durable commit record and must win over
        // the stale in-flight state.
        let recoveredPublishedAtlas = false;
        if (ws.atlasRun?.status === 'running' || ws.atlasRun?.status === 'validating') {
          if (ws.atlasProjectCwd) {
            const manifestPath = join(ws.atlasProjectCwd, 'docs', 'ui-atlas', 'manifest.json');
            try {
              if (statSync(manifestPath).size <= 64 * 1024) {
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                const publishedAt = Date.parse(manifest?.generatedAt);
                if (manifest?.runId === ws.atlasRun.id && manifest?.status === 'complete' && Number.isFinite(publishedAt)) {
                  ws.atlasRun = {
                    ...ws.atlasRun,
                    status: 'completed',
                    phase: 'published',
                    finishedAt: publishedAt,
                    lastActivityAt: Math.max(ws.atlasRun.lastActivityAt, publishedAt),
                    validationErrors: [],
                    error: undefined,
                  };
                  ws.atlasLastScanAt = Math.max(ws.atlasLastScanAt || 0, publishedAt);
                  recoveredPublishedAtlas = true;
                  recoveryChanged = true;
                }
              }
            } catch {}
          }
          // An in-flight process cannot survive a server restart. Keep its
          // candidate and surface a resumable state instead of pretending the
          // scan completed or silently starting it over.
          if (!recoveredPublishedAtlas) {
            recoveryChanged = true;
            ws.atlasRun = {
              ...ws.atlasRun,
              status: 'paused',
              finishedAt: Date.now(),
              error: 'Agent Forge restarted before this Atlas run completed. Resume to continue from its candidate checkpoint.',
            };
          }
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
              recoveryChanged = true;
              console.log(`[workspace] imported legacy atlas timestamp for ${ws.name}`);
            } catch {}
          }
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
