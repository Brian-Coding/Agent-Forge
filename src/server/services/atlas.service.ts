import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type { AgentInfo } from '../../shared/protocol';
import { broadcast } from '../broadcast';
import { agentService } from './agent.service';
import { workspaceService } from './workspace.service';
import { UI_ATLAS_SYSTEM_PROMPT_TEMPLATE } from './prompts/atlas-system-prompt';

// GUI port set by index.ts after Bun.serve binds. Same source as qa.service
// so the two stay in sync — both substitute {GUI_PORT} into their templates.
let guiPort: number = ((globalThis as any).__guiPort as number) || 0;

/**
 * Reconcile the workspace's atlasLastScanAt with the on-disk atlas.md mtime
 * whenever the atlas agent goes idle for any reason (clean exit, error, stop,
 * timeout). Old logic only stamped on exitCode === 0 — runs that errored or
 * timed out but still wrote atlas.md left the workspace stuck on a stale
 * timestamp from the previous successful scan.
 */
async function reconcileAtlasFreshness(agentId: string): Promise<void> {
  const wsId = agentService.getAgentWorkspaceId(agentId);
  if (!wsId) return;
  const ws = workspaceService.get(wsId);
  if (!ws || ws.atlasAgentId !== agentId || !ws.atlasProjectCwd) return;
  const atlasMd = join(ws.atlasProjectCwd, 'docs', 'ui-atlas', 'atlas.md');
  if (!existsSync(atlasMd)) return;
  try {
    const mtimeMs = statSync(atlasMd).mtimeMs;
    if ((ws.atlasLastScanAt ?? 0) >= mtimeMs) return;
    const updated = await workspaceService.update(wsId, { atlasLastScanAt: mtimeMs });
    if (updated) broadcast({ type: 'workspace_updated', workspace: updated });
    console.log(`[atlas] stamped atlasLastScanAt for ${ws.name} from atlas.md mtime (${new Date(mtimeMs).toISOString()})`);
  } catch (e) {
    console.warn('[atlas] reconcileAtlasFreshness failed:', e);
  }
}

export const atlasService = {
  /** Called by index.ts after Bun.serve binds — substituted into the Atlas system prompt. */
  setGuiPort(port: number): void {
    guiPort = port;
    (globalThis as any).__guiPort = port;
  },

  /**
   * Provision a UI Atlas Agent for a workspace. Unlike the QA agent (which is
   * provisioned lazily on first send), the Atlas agent is created explicitly
   * by user action — it needs a project cwd to read code from + a test URL to
   * walk the app at, both of which the user supplies.
   *
   * Returns the created agent's info. Callers (the WS handler) broadcast the
   * resulting agent_created message and let the user prompt the agent
   * directly via the existing sendMessage flow. Also auto-kicks off the
   * initial discovery turn so the user doesn't have to click into chat.
   */
  async provisionAtlasAgent(workspaceId: string, projectCwd: string): Promise<AgentInfo> {
    const ws = workspaceService.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (!ws.testUrl) throw new Error('Workspace has no Test URL set — set one in the sidebar before provisioning the Atlas Agent');
    if (!existsSync(projectCwd)) throw new Error(`Project directory does not exist: ${projectCwd}`);

    // Recycle the browser worker before a long atlas scan to clear accumulated state.
    const { browserService } = await import('./browser.service');
    await browserService.recycle().catch(e => console.warn('[atlas] worker recycle failed (continuing):', e));

    // If an atlas already exists at the target path, archive it before
    // proceeding so the new run starts from a clean slate.
    const atlasMdPath = join(projectCwd, 'docs', 'ui-atlas', 'atlas.md');
    if (existsSync(atlasMdPath)) {
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const atlasDir = path.join(projectCwd, 'docs', 'ui-atlas');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveDir = path.join(atlasDir, '.history', stamp);
        await fs.mkdir(archiveDir, { recursive: true });
        try { await fs.rename(path.join(atlasDir, 'atlas.md'), path.join(archiveDir, 'atlas.md')); } catch {}
        try { await fs.copyFile(path.join(atlasDir, 'changelog.md'), path.join(archiveDir, 'changelog.md')); } catch {}
        try { await fs.rename(path.join(atlasDir, 'shots'), path.join(archiveDir, 'shots')); } catch {}
        console.log(`[atlas] Build detected existing atlas — archived to ${archiveDir}`);
      } catch (e) {
        console.warn('[atlas] archive step failed during Build (continuing):', e);
      }
    }

    const port = guiPort > 0 ? guiPort : 3333;
    const systemPrompt = UI_ATLAS_SYSTEM_PROMPT_TEMPLATE
      .replace(/{GUI_PORT}/g, String(port))
      .replace(/{WORKSPACE_ID}/g, workspaceId)
      .replace(/{TEST_URL}/g, ws.testUrl);

    const created = await agentService.createAgent('UI Atlas Agent', projectCwd, [], systemPrompt, workspaceId, { hideFromGrid: true });
    const updated = await workspaceService.update(workspaceId, {
      atlasAgentId: created.id,
      atlasProjectCwd: projectCwd,
    });
    if (updated) broadcast({ type: 'workspace_updated', workspace: updated });

    // Auto-trigger the initial discovery.
    const kickoff = `Build the initial UI Atlas for this project per your system prompt. Be exhaustive — every surface in §2 needs a verified screenshot, every entity in §1 needs at least one verified surface, and Pass 6 self-verification must pass before you write the final atlas. Use /api/browser/evaluate aggressively for any surface that doesn't yield to clicks (canvas double-clicks, planet selection, multi-system empire state, in-flight battle state, etc). Use stable per-surface filenames ("name": "surface-<slug>") on every screenshot.`;
    agentService.sendMessage(created.id, kickoff).catch(e => {
      console.error(`[atlas] auto-kickoff failed for ${created.id}:`, e);
    });

    return created;
  },

  /**
   * Re-scan flow: archive current atlas, wipe shots/, delete the existing
   * atlas agent (gets a fresh one with the latest system prompt), then
   * provision a new agent + auto-trigger.
   */
  async rescanAtlas(workspaceId: string): Promise<AgentInfo> {
    const ws = workspaceService.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (!ws.atlasProjectCwd) throw new Error('No prior atlas — use Build instead of Re-scan');

    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const atlasDir = path.join(ws.atlasProjectCwd, 'docs', 'ui-atlas');
    const archiveRoot = path.join(atlasDir, '.history');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archiveDir = path.join(archiveRoot, stamp);
    try {
      await fs.mkdir(archiveDir, { recursive: true });
      const atlasMd = path.join(atlasDir, 'atlas.md');
      try { await fs.rename(atlasMd, path.join(archiveDir, 'atlas.md')); } catch {}
      const changelog = path.join(atlasDir, 'changelog.md');
      try { await fs.copyFile(changelog, path.join(archiveDir, 'changelog.md')); } catch {}
      const shotsDir = path.join(atlasDir, 'shots');
      try { await fs.rename(shotsDir, path.join(archiveDir, 'shots')); } catch {}
      console.log(`[atlas] archived previous scan to ${archiveDir}`);
    } catch (e) {
      console.warn(`[atlas] archive step failed (continuing):`, e);
    }

    if (ws.atlasAgentId && agentService.getAgent(ws.atlasAgentId)) {
      await agentService.removeAgent(ws.atlasAgentId);
    }

    return atlasService.provisionAtlasAgent(workspaceId, ws.atlasProjectCwd);
  },
};

// Subscribe to agent-idle so we always reconcile atlas freshness when the atlas
// agent goes idle — even on user-stop or timeout. Registered once at module load.
agentService.onAgentIdle(async (agentId: string) => {
  await reconcileAtlasFreshness(agentId);
});
