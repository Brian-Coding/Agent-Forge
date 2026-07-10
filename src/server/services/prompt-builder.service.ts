import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AgentInfo } from '../../shared/protocol';
import { documentService } from './document.service';
import { settingsService } from './settings.service';
import { workspaceService } from './workspace.service';

const DEFAULT_GUARDRAILS = `IMPORTANT GUARDRAILS — follow these at all times:
- NEVER run git commit, git push, git push --force, or git merge unless the user EXPLICITLY asks you to.
- NEVER delete branches (git branch -D/-d) unless the user EXPLICITLY asks you to.
- NEVER run destructive commands (rm -rf, git reset --hard, git checkout ., git clean) unless the user EXPLICITLY asks you to.
- Before making changes, briefly state what you plan to do and which files you'll modify.
- If you're unsure about something, ask the user rather than guessing.`;

const PLAN_MANAGEMENT_INSTRUCTIONS = `Plan Management:
When asked to create or update a plan, use the Write tool to write a markdown file to the .plans/ directory in your working directory.
- To create a new plan: Write to .plans/<plan-name>.md
- To update an existing plan: Write the complete updated content to the same file path
- The user reads plan files directly from the repo in their IDE
- Plans marked [APPROVED] should be followed as-is
- Plans marked [DRAFT] are pending user review`;

const CONVERSATION_SCOPE_INSTRUCTIONS = `Conversation Scope:
You are primarily a software engineering agent for this workspace, but the user may also ask harmless general questions, casual questions, or quick factual questions. Answer those directly.
- Do not refuse or redirect solely because a question is not about the project.
- Do not add "back to code" reminders unless the user asks for project work or appears to be waiting on a software task.
- Still follow all safety rules and do not modify files unless explicitly asked.`;

function buildAtlasCitationBlock(atlasMd: string): string {
  return `UI Atlas — citation required for UI work
This workspace has a UI Atlas at \`${atlasMd}\` (already in your reference directories). It is a comprehensive map of every UI surface, every entity rendered, and the click paths to each one.

When the user's request involves UI/UX, components, screens, panels, modals, or game/app surfaces:
1. READ the relevant section of the atlas FIRST. The atlas is the source of truth for what surfaces exist and what they show.
2. CITE specific surface IDs (\`surface.<slug>\`) and entity IDs (\`entity.<slug>\`) when proposing changes or answering questions. e.g. "Per atlas surface.fleet-management-modal-split, the split tab already shows ship counts; we'd add ..."
3. PREFER the atlas over guessing. If the atlas's §5 (Observed inconsistencies) or §7 (Open questions) flags something relevant to the request, mention it.
4. If the atlas seems out of date for the area you're touching, say so explicitly — don't silently work around stale data.

This is a load-bearing instruction. Atlas-grounded answers are dramatically more useful than answers that ignore it.`;
}

export interface PromptBuildResult {
  /** The full assembled string to pass as --append-system-prompt (Claude) or splice into the prompt body (other providers). */
  appendedSystemPrompt: string;
  /** Subset of agent.referencePaths that exist on disk. Adapters use this for --add-dir / equivalent flags. */
  validReferencePaths: string[];
}

/**
 * Build the agent's appended system prompt + resolve which reference paths exist.
 * Provider-agnostic — every adapter calls this through the chat.service bridge.
 *
 * Sections (in order):
 *   1. Guardrails
 *   2. Agent persona (from agent.systemPrompt)
 *   3. Project context (workspace-shared)
 *   4. Documents (plans relevant to this agent / workspace)
 *   5. Plan Management instructions (so the agent knows .plans/* is special)
 *   6. Default iOS simulator (if set and cwd looks iOS-ish)
 *   7. Reference directories
 *   8. Atlas citation (when the workspace has a built atlas and the agent isn't a workspace tool)
 */
export const promptBuilderService = {
  build(agentInfo: AgentInfo, sharedContext: string): PromptBuildResult {
    const parts: string[] = [DEFAULT_GUARDRAILS];

    if (agentInfo.systemPrompt) {
      parts.push(`Agent Persona:\n${agentInfo.systemPrompt}`);
    }
    if (sharedContext) {
      parts.push(`Project Context:\n${sharedContext}`);
    }
    const docsContext = documentService.getDocumentsForAgent(agentInfo.id, agentInfo.workspaceId);
    if (docsContext) {
      parts.push(docsContext);
    }
    parts.push(PLAN_MANAGEMENT_INSTRUCTIONS);
    parts.push(CONVERSATION_SCOPE_INSTRUCTIONS);

    // Ensure .plans/ exists in the agent's cwd so the plan-management instructions
    // don't refer to a nonexistent directory.
    const plansDir = join(agentInfo.cwd, '.plans');
    try { mkdirSync(plansDir, { recursive: true }); } catch {}

    const settings = settingsService.get();
    if (settings.defaultSimulatorUdid) {
      const cwdLower = agentInfo.cwd.toLowerCase();
      const isIos = cwdLower.includes('ios') || cwdLower.includes('xcode') || cwdLower.includes('swift') || cwdLower.includes('apple');
      if (isIos || settings.defaultSimulatorName) {
        parts.push(`Default iOS Simulator: ${settings.defaultSimulatorName || 'Unknown'} (UDID: ${settings.defaultSimulatorUdid})`);
      }
    }

    // Resolve which reference paths actually exist on disk. We return these
    // separately so the adapter can pass them to --add-dir / equivalent.
    const validReferencePaths: string[] = [];
    for (const dir of agentInfo.referencePaths) {
      if (existsSync(dir)) validReferencePaths.push(dir);
    }
    if (validReferencePaths.length > 0) {
      const refNames = validReferencePaths.map(p => {
        // Use both separators since paths may be Windows or POSIX
        const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
        return `- ${name}: ${p}`;
      }).join('\n');
      parts.push(`Reference Directories (read-only context — you have full access to browse these):\n${refNames}\n\nIMPORTANT: These reference directories were explicitly added by the user as additional context for your work. You should be aware of them and use them when relevant. Your primary working directory is: ${agentInfo.cwd}`);
    }

    // Atlas citation for non-special agents in workspaces that have a built atlas.
    if (!agentInfo.hideFromGrid) {
      const ws = workspaceService.get(agentInfo.workspaceId);
      if (ws?.atlasProjectCwd) {
        const atlasMd = join(ws.atlasProjectCwd, 'docs', 'ui-atlas', 'atlas.md');
        if (existsSync(atlasMd)) {
          parts.push(buildAtlasCitationBlock(atlasMd));
        }
      }
    }

    return {
      appendedSystemPrompt: parts.join('\n\n'),
      validReferencePaths,
    };
  },
};
