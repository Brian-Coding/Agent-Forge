import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentInfo, AtlasRunInfo, WorkspaceInfo } from '../../shared/protocol';
import { broadcast } from '../broadcast';
import { generateId } from '../utils';
import { agentService } from './agent.service';
import {
  atlasCandidatePaths,
  createAtlasCandidate,
  discardAtlasCandidate,
  promoteAtlasCandidate,
  validateAtlasCandidate,
} from './atlas-artifacts';
import { browserService } from './browser.service';
import { workspaceService } from './workspace.service';
import { UI_ATLAS_SYSTEM_PROMPT_TEMPLATE } from './prompts/atlas-system-prompt';
import { CODEX_XHIGH_SPECIALIST_PROFILE } from './specialist-agent-profile';

let guiPort: number = ((globalThis as any).__guiPort as number) || 0;

export const UI_ATLAS_AGENT_PROFILE = CODEX_XHIGH_SPECIALIST_PROFILE;

const UI_ATLAS_AGENT_CREATE_OPTIONS = Object.freeze({
  hideFromGrid: true,
  ...UI_ATLAS_AGENT_PROFILE,
});

// A run is driven by exactly one agent turn at a time. HMR-safe so a hot
// reload cannot accidentally launch the same candidate twice.
const executingAtlasRuns: Set<string> = (globalThis as any).__executingAtlasRuns ??= new Set<string>();

function broadcastWorkspace(workspace: WorkspaceInfo | null | undefined): void {
  if (workspace) broadcast({ type: 'workspace_updated', workspace });
}

async function ensureAtlasAgentProfile(agent: AgentInfo): Promise<AgentInfo> {
  if (
    agent.provider === UI_ATLAS_AGENT_PROFILE.provider
    && agent.model === UI_ATLAS_AGENT_PROFILE.model
    && agent.reasoningLevel === UI_ATLAS_AGENT_PROFILE.reasoningLevel
  ) {
    return agent;
  }
  const updated = await agentService.updateAgent(agent.id, UI_ATLAS_AGENT_PROFILE);
  if (!updated) throw new Error('The UI Atlas agent disappeared while applying its Codex profile');
  return updated;
}

function buildAtlasPrompt(
  workspaceId: string,
  testUrl: string,
  runId: string,
  candidateRoot: string,
  browserSessionId: string,
): string {
  const port = guiPort > 0 ? guiPort : 3333;
  return UI_ATLAS_SYSTEM_PROMPT_TEMPLATE
    .replace(/{GUI_PORT}/g, String(port))
    .replace(/{WORKSPACE_ID}/g, workspaceId)
    .replace(/{TEST_URL}/g, testUrl)
    .replace(/{ATLAS_RUN_ID}/g, runId)
    .replace(/{ATLAS_OUTPUT_DIR}/g, candidateRoot.replace(/\\/g, '/'))
    .replace(/{BROWSER_SESSION_ID}/g, browserSessionId);
}

async function removePriorAtlasAgent(workspace: WorkspaceInfo): Promise<void> {
  if (!workspace.atlasAgentId) return;
  const existing = agentService.getAgent(workspace.atlasAgentId);
  if (!existing) {
    broadcastWorkspace(await workspaceService.update(workspace.id, { atlasAgentId: null }));
    return;
  }
  if (existing.name !== 'UI Atlas Agent') {
    // Never remove an ordinary coding agent because of a stale association.
    broadcastWorkspace(await workspaceService.update(workspace.id, { atlasAgentId: null }));
    return;
  }
  if (existing.status === 'working' || existing.status === 'thinking') {
    throw new Error('The existing Atlas agent is still running. Stop it before starting another scan.');
  }
  const removed = await agentService.removeAgent(existing.id);
  if (removed) broadcast({ type: 'agent_removed', agentId: existing.id });
  broadcastWorkspace(await workspaceService.update(workspace.id, { atlasAgentId: null }));
}

function lastAtlasOutputWasInterrupted(agentId: string): boolean {
  const text = agentService.getLastAssistantMessage(agentId)?.content || '';
  return /\[Stopped(?::| by )/i.test(text);
}

async function retainedQaSurfaceVerifications(workspace: WorkspaceInfo): Promise<Record<string, number>> {
  const current = workspace.qaSurfaceVerifications || {};
  if (!workspace.atlasProjectCwd || Object.keys(current).length === 0) return current;
  try {
    const graph = JSON.parse(await readFile(resolve(workspace.atlasProjectCwd, 'docs', 'ui-atlas', 'atlas.json'), 'utf8')) as {
      surfaces?: Array<{ id?: string }>;
    };
    const allowed = new Set((graph.surfaces || [])
      .map(surface => surface.id?.replace(/^surface\./, ''))
      .filter((id): id is string => !!id));
    return Object.fromEntries(Object.entries(current).filter(([slug]) => allowed.has(slug)));
  } catch {
    return current;
  }
}

async function finalizeAtlasRun(
  workspaceId: string,
  agentId: string,
  runId: string,
  executionError?: string,
): Promise<void> {
  const ws = workspaceService.get(workspaceId);
  if (!ws?.atlasRun || ws.atlasRun.id !== runId || ws.atlasAgentId !== agentId || !ws.atlasProjectCwd) return;

  const validating: AtlasRunInfo = {
    ...ws.atlasRun,
    status: 'validating',
    phase: 'validating candidate',
    lastActivityAt: Date.now(),
    error: executionError,
  };
  broadcastWorkspace(await workspaceService.update(workspaceId, { atlasRun: validating }));

  let publicationSucceeded = false;
  try {
    const validation = await validateAtlasCandidate(ws.atlasProjectCwd, runId);
    if (!validation.valid) {
      const paused = lastAtlasOutputWasInterrupted(agentId);
      const terminal: AtlasRunInfo = {
        ...validating,
        status: paused ? 'paused' : 'failed',
        phase: paused ? 'paused at checkpoint' : 'candidate needs attention',
        finishedAt: Date.now(),
        lastActivityAt: Date.now(),
        validationErrors: validation.errors,
        error: executionError || (paused
          ? 'Scan stopped before the candidate was complete. The last published Atlas is unchanged.'
          : 'Candidate validation failed. Resume the run after reviewing the validation details.'),
        surfaceCount: validation.surfaceCount,
        entityCount: validation.entityCount,
        verifiedSurfaceCount: validation.verifiedSurfaceCount,
      };
      broadcastWorkspace(await workspaceService.update(workspaceId, { atlasRun: terminal }));
      console.warn(`[atlas] run ${runId} not published (${terminal.status}): ${validation.errors.join('; ')}`);
      return;
    }

    const promoted = await promoteAtlasCandidate(ws.atlasProjectCwd, runId);
    publicationSucceeded = true;
    const publishedAt = Date.now();
    const completed: AtlasRunInfo = {
      ...validating,
      status: 'completed',
      phase: 'published',
      finishedAt: Date.now(),
      lastActivityAt: Date.now(),
      validationErrors: [],
      error: undefined,
      surfaceCount: promoted.surfaceCount,
      entityCount: promoted.entityCount,
      verifiedSurfaceCount: promoted.verifiedSurfaceCount,
    };
    const qaSurfaceVerifications = await retainedQaSurfaceVerifications(ws);
    broadcastWorkspace(await workspaceService.update(workspaceId, {
      atlasRun: completed,
      atlasLastScanAt: publishedAt,
      qaSurfaceVerifications,
    }));
    await discardAtlasCandidate(ws.atlasProjectCwd, runId).catch(error => {
      console.warn(`[atlas] published run ${runId}, but candidate cleanup failed:`, error);
    });
    console.log(`[atlas] published validated run ${runId}: ${promoted.surfaceCount} surfaces, ${promoted.entityCount} entities`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = workspaceService.get(workspaceId)?.atlasRun;
    if (current?.id === runId) {
      if (publicationSucceeded) {
        // The canonical directory already contains the new run. Never label it
        // failed merely because persistence/broadcasting cleanup had trouble.
        const recovered: AtlasRunInfo = {
          ...current,
          status: 'completed',
          phase: 'published',
          finishedAt: current.finishedAt || Date.now(),
          lastActivityAt: Date.now(),
          validationErrors: [],
          error: undefined,
        };
        try {
          broadcastWorkspace(await workspaceService.update(workspaceId, {
            atlasRun: recovered,
            atlasLastScanAt: Date.now(),
          }));
        } catch (persistError) {
          console.error(`[atlas] run ${runId} is published but completion state could not be persisted:`, persistError);
          broadcastWorkspace(workspaceService.get(workspaceId));
        }
        return;
      }
      const failed: AtlasRunInfo = {
        ...current,
        status: 'failed',
        phase: 'publication failed',
        finishedAt: Date.now(),
        lastActivityAt: Date.now(),
        error: message,
      };
      broadcastWorkspace(await workspaceService.update(workspaceId, { atlasRun: failed }));
    }
    console.error(`[atlas] finalization failed for ${runId}:`, error);
  } finally {
    const sessionId = workspaceService.get(workspaceId)?.atlasRun?.browserSessionId;
    if (sessionId) await browserService.closeContext(workspaceId, sessionId).catch(() => {});
  }
}

async function refreshAtlasCheckpoint(workspaceId: string, runId: string): Promise<void> {
  const ws = workspaceService.get(workspaceId);
  if (!ws?.atlasRun || ws.atlasRun.id !== runId || ws.atlasRun.status !== 'running' || !ws.atlasProjectCwd) return;
  const checkpointPath = resolve(atlasCandidatePaths(ws.atlasProjectCwd, runId).candidateRoot, 'checkpoint.json');
  try {
    const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
      runId?: string;
      phase?: string;
      lastActivityAt?: string;
    };
    if (checkpoint.runId !== runId) return;
    const parsedActivity = checkpoint.lastActivityAt ? Date.parse(checkpoint.lastActivityAt) : NaN;
    const nextActivity = Number.isFinite(parsedActivity)
      ? Math.max(ws.atlasRun.lastActivityAt, Math.min(Date.now(), parsedActivity))
      : ws.atlasRun.lastActivityAt;
    const nextPhase = typeof checkpoint.phase === 'string' && checkpoint.phase.trim()
      ? checkpoint.phase.trim().slice(0, 160)
      : ws.atlasRun.phase;
    if (nextActivity === ws.atlasRun.lastActivityAt && nextPhase === ws.atlasRun.phase) return;
    broadcastWorkspace(await workspaceService.update(workspaceId, {
      atlasRun: { ...ws.atlasRun, lastActivityAt: nextActivity, phase: nextPhase },
    }));
  } catch {
    // The agent may be between its temp write and rename. A later poll retries.
  }
}

async function executeAtlasTurn(
  workspaceId: string,
  agentId: string,
  runId: string,
  prompt: string,
): Promise<void> {
  if (executingAtlasRuns.has(runId)) return;
  executingAtlasRuns.add(runId);
  let executionError: string | undefined;
  let checkpointSync: Promise<void> = Promise.resolve();
  const syncCheckpoint = () => {
    checkpointSync = checkpointSync.then(() => refreshAtlasCheckpoint(workspaceId, runId));
  };
  const checkpointTimer = setInterval(syncCheckpoint, 2500);
  checkpointTimer.unref?.();
  try {
    await agentService.sendMessage(agentId, prompt);
  } catch (error) {
    console.error(`[atlas] agent turn failed for ${runId}:`, error);
    executionError = 'The Atlas agent turn failed before completion.';
  } finally {
    try {
      clearInterval(checkpointTimer);
      syncCheckpoint();
      await checkpointSync;
      await finalizeAtlasRun(workspaceId, agentId, runId, executionError);
    } finally {
      executingAtlasRuns.delete(runId);
    }
  }
}

async function startAtlasRun(
  workspaceId: string,
  projectCwd: string,
  mode: 'build' | 'rescan',
): Promise<AgentInfo> {
  const ws = workspaceService.get(workspaceId);
  if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
  if (!ws.testUrl) throw new Error('Workspace has no Test URL set — set one before starting an Atlas scan');
  const projectRoot = resolve(projectCwd);
  if (!existsSync(projectRoot)) throw new Error(`Project directory does not exist: ${projectRoot}`);
  if (!statSync(projectRoot).isDirectory()) throw new Error(`Atlas project path is not a directory: ${projectRoot}`);

  const active = ws.atlasRun;
  if (active?.status === 'running' || active?.status === 'validating') {
    throw new Error('An Atlas scan is already active for this workspace');
  }
  if (active && (active.status === 'paused' || active.status === 'failed')) {
    const partial = atlasCandidatePaths(ws.atlasProjectCwd || projectRoot, active.id).candidateRoot;
    if (existsSync(partial)) throw new Error('A resumable Atlas candidate already exists. Resume or discard it before starting a new scan.');
  }

  await removePriorAtlasAgent(ws);
  const runId = generateId();
  const candidate = await createAtlasCandidate(projectRoot, runId);
  const browserSessionId = `atlas-${runId}`;
  const systemPrompt = buildAtlasPrompt(workspaceId, ws.testUrl, runId, candidate.candidateRoot, browserSessionId);

  let created: AgentInfo;
  try {
    created = await agentService.createAgent('UI Atlas Agent', projectRoot, [], systemPrompt, workspaceId, UI_ATLAS_AGENT_CREATE_OPTIONS);
  } catch (error) {
    await discardAtlasCandidate(projectRoot, runId).catch(() => {});
    throw error;
  }

  const now = Date.now();
  const run: AtlasRunInfo = {
    id: runId,
    mode,
    status: 'running',
    candidateRelPath: candidate.candidateRelPath,
    browserSessionId,
    createdAt: now,
    startedAt: now,
    lastActivityAt: now,
    phase: mode === 'build' ? 'initial discovery' : 'updating from current Atlas',
    resumeCount: 0,
  };
  broadcastWorkspace(await workspaceService.update(workspaceId, {
    atlasAgentId: created.id,
    atlasProjectCwd: projectRoot,
    atlasRun: run,
  }));

  const kickoff = [
    `${mode === 'build' ? 'Build' : 'Update'} the UI Atlas using the transactional run contract in your system prompt.`,
    `Run ID: ${runId}`,
    `Candidate output: ${candidate.candidateRoot.replace(/\\/g, '/')}`,
    `Browser session ID: ${browserSessionId}`,
    mode === 'rescan'
      ? 'Read the currently published docs/ui-atlas/ Atlas as your baseline, but do not modify it. Write every new artifact only to the candidate output.'
      : 'This is an initial discovery. Do not publish directly to docs/ui-atlas; the harness will validate and promote your candidate.',
    'Update checkpoint.json after each pass and each verified surface. Only mark checkpoint.json and manifest.json complete after atlas.md, atlas.json, and every referenced screenshot are ready.',
  ].join('\n\n');
  void executeAtlasTurn(workspaceId, created.id, runId, kickoff);
  return created;
}

export const atlasService = {
  setGuiPort(port: number): void {
    guiPort = port;
    (globalThis as any).__guiPort = port;
  },

  async provisionAtlasAgent(workspaceId: string, projectCwd: string): Promise<AgentInfo> {
    return startAtlasRun(workspaceId, projectCwd, 'build');
  },

  async rescanAtlas(workspaceId: string): Promise<AgentInfo> {
    const ws = workspaceService.get(workspaceId);
    if (!ws) throw new Error(`Workspace not found: ${workspaceId}`);
    if (!ws.atlasProjectCwd) throw new Error('No Atlas project directory is configured — use Build first');
    return startAtlasRun(workspaceId, ws.atlasProjectCwd, 'rescan');
  },

  async resumeAtlas(workspaceId: string): Promise<{ agent: AgentInfo; created: boolean }> {
    const ws = workspaceService.get(workspaceId);
    if (!ws?.atlasRun || !ws.atlasProjectCwd || !ws.testUrl) throw new Error('No resumable Atlas run found');
    if (ws.atlasRun.status !== 'paused' && ws.atlasRun.status !== 'failed') {
      throw new Error(`Atlas run is ${ws.atlasRun.status}, not resumable`);
    }
    if (executingAtlasRuns.has(ws.atlasRun.id)) {
      throw new Error('The previous Atlas turn is still finishing. Try Resume again in a moment.');
    }
    const candidate = atlasCandidatePaths(ws.atlasProjectCwd, ws.atlasRun.id);
    if (!existsSync(candidate.candidateRoot)) throw new Error('The Atlas candidate directory no longer exists');

    let agent = ws.atlasAgentId ? agentService.getAgent(ws.atlasAgentId) : undefined;
    let created = false;
    if (agent && agent.name !== 'UI Atlas Agent') agent = undefined;
    if (agent && !agent.systemPrompt.includes(ws.atlasRun.id)) {
      if (agent.status === 'working' || agent.status === 'thinking') {
        throw new Error('The existing Atlas agent is still active. Stop it before resuming this candidate.');
      }
      const removed = await agentService.removeAgent(agent.id);
      if (removed) broadcast({ type: 'agent_removed', agentId: agent.id });
      agent = undefined;
    }
    if (!agent) {
      const systemPrompt = buildAtlasPrompt(
        workspaceId,
        ws.testUrl,
        ws.atlasRun.id,
        candidate.candidateRoot,
        ws.atlasRun.browserSessionId,
      );
      agent = await agentService.createAgent('UI Atlas Agent', ws.atlasProjectCwd, [], systemPrompt, workspaceId, UI_ATLAS_AGENT_CREATE_OPTIONS);
      created = true;
    } else if (agent.status === 'working' || agent.status === 'thinking') {
      throw new Error('The Atlas agent is already active');
    }
    agent = await ensureAtlasAgentProfile(agent);

    const priorValidationErrors = ws.atlasRun.validationErrors || [];
    const resumed: AtlasRunInfo = {
      ...ws.atlasRun,
      status: 'running',
      phase: 'resuming from checkpoint',
      finishedAt: undefined,
      lastActivityAt: Date.now(),
      validationErrors: [],
      error: undefined,
      resumeCount: (ws.atlasRun.resumeCount || 0) + 1,
    };
    broadcastWorkspace(await workspaceService.update(workspaceId, {
      atlasAgentId: agent.id,
      atlasRun: resumed,
    }));

    const prompt = [
      `Resume Atlas run ${resumed.id}; do not restart it.`,
      `Read ${candidate.candidateRoot.replace(/\\/g, '/')}/checkpoint.json and inspect the existing candidate artifacts.`,
      'Continue from the first incomplete pass/surface, preserve valid work already present, fix every validation error included below, then complete the manifest and checkpoint.',
      priorValidationErrors.length ? priorValidationErrors.map(error => `- ${error}`).join('\n') : '(No prior validation detail was recorded.)',
    ].join('\n\n');
    void executeAtlasTurn(workspaceId, agent.id, resumed.id, prompt);
    return { agent, created };
  },

  async discardCandidate(workspaceId: string): Promise<void> {
    const ws = workspaceService.get(workspaceId);
    if (!ws?.atlasRun || !ws.atlasProjectCwd) throw new Error('No Atlas candidate to discard');
    if (ws.atlasRun.status === 'running' || ws.atlasRun.status === 'validating') {
      throw new Error('Stop the Atlas scan before discarding its candidate');
    }
    await discardAtlasCandidate(ws.atlasProjectCwd, ws.atlasRun.id);
    const atlasAgent = ws.atlasAgentId ? agentService.getAgent(ws.atlasAgentId) : undefined;
    if (atlasAgent?.name === 'UI Atlas Agent') {
      const removed = await agentService.removeAgent(atlasAgent.id);
      if (removed) broadcast({ type: 'agent_removed', agentId: atlasAgent.id });
    }
    broadcastWorkspace(await workspaceService.update(workspaceId, { atlasAgentId: null, atlasRun: null }));
  },
};
