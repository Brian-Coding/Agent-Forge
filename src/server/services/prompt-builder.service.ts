import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AgentInfo } from '../../shared/protocol';
import { documentService } from './document.service';
import { settingsService } from './settings.service';

const DEFAULT_GUARDRAILS = `IMPORTANT GUARDRAILS — follow these at all times:
- NEVER run git commit, git push, git push --force, or git merge unless the user EXPLICITLY asks you to.
- Before every commit or push, inspect the current branch and all local and remote-tracking branches.
- If a local or remote-tracking develop branch exists, NEVER commit or push directly to master. Use develop or a feature branch instead.
- Direct commits and pushes to master are permitted only when no develop branch exists locally or remotely.
- Never assume the currently checked-out branch is the correct destination for a commit or push.
- NEVER delete branches (git branch -D/-d) unless the user EXPLICITLY asks you to.
- NEVER run destructive commands (rm -rf, git reset --hard, git checkout ., git clean) unless the user EXPLICITLY asks you to.
- Before any recursive delete or move, resolve every target to an absolute real path, verify it is strictly inside the intended narrow root, inspect what is present, and reject symlinks or junctions. Fail closed if the target is missing, ambiguous, unexpectedly populated, or outside scope.
- Never reuse HOME, USERPROFILE, CODEX_HOME, the workspace root, or another system/configuration environment variable as a temporary path. Create a fresh uniquely named temporary directory under the platform temp directory and retain its exact path for cleanup.
- Prefer a recoverable quarantine or trash operation over permanent deletion. Use a dry-run/preflight when available, and re-check the resolved target immediately before acting.
- Never delete or overwrite a pre-existing temporary path merely because its name looks disposable; create a new path or stop and ask when ownership is unclear.
- Preserve unrelated and pre-existing worktree changes. Never revert or overwrite work you did not create unless the user explicitly asks.
- Never expose secrets, tokens, credential values, or private environment-variable values. You may identify secret names and configuration locations without printing their values.
- External services are read-only unless the user explicitly authorizes a mutation in the current request. This includes deployments, production changes, project/domain changes, environment-variable changes, rollbacks, billing, and account/team access.
- Before making changes, briefly state what you plan to do and which files you'll modify.
- Verify changes in proportion to their risk and report any checks you could not run.
- If you're unsure about something material, ask the user rather than guessing.`;

/** Trim shared project context before it is stored or injected. */
export function normalizeSharedProjectContext(content: string | undefined): string {
  return String(content || '').trim();
}

const PLAN_MANAGEMENT_INSTRUCTIONS = `Plan Management:
When asked to create or update a plan, use the Write tool to write a markdown file to the .plans/ directory in your working directory.
- To create a new plan: Write to .plans/<plan-name>.md
- To update an existing plan: Write the complete updated content to the same file path
- The user reads plan files directly from the repo in their IDE
- Read .plans/README.md when present; it is the lifecycle catalog and identifies the canonical plan of record
- Put an explicit Lifecycle line near the top of every plan
- Approved plans may be implemented; Draft plans are pending review; In Progress plans have named acceptance work remaining
- Paused plans must not be implemented until the user resumes them; Completed, Superseded, and Reference plans are context only
- A newer explicit user instruction takes precedence over a document lifecycle label`;

const REPORT_DELIVERY_INSTRUCTIONS = `Report Delivery:
- Put user-facing reports, runbooks, QA findings, and completion summaries directly in the final chat response whenever practical.
- If a report is too long for chat, write the complete Markdown file inside the current project and still include its conclusions and useful summary in chat.
- Never make a bare local filesystem link the only delivery of work the user asked to read.`;

const CONVERSATION_SCOPE_INSTRUCTIONS = `Conversation Scope:
You are primarily a software engineering agent for this workspace, but the user may also ask harmless general questions, casual questions, or quick factual questions. Answer those directly.
- Do not refuse or redirect solely because a question is not about the project.
- Do not add "back to code" reminders unless the user asks for project work or appears to be waiting on a software task.
- Still follow all safety rules and do not modify files unless explicitly asked.`;

export interface HarnessInstructionSection {
  id: string;
  title: string;
  description: string;
  content: string;
}

/** Read-only manifest for the Harness Settings UI; sourced from the exact prompt constants. */
export function getBuiltInHarnessInstructionManifest(): {
  sections: HarnessInstructionSection[];
  assemblyOrder: string[];
} {
  return {
    sections: [
      {
        id: 'guardrails',
        title: 'Safety and change-control guardrails',
        description: 'Protects Git history, existing work, credentials, external services, and verification expectations.',
        content: DEFAULT_GUARDRAILS,
      },
      {
        id: 'reports',
        title: 'Report delivery',
        description: 'Ensures reports are readable in chat and never delivered only as inaccessible filesystem links.',
        content: REPORT_DELIVERY_INSTRUCTIONS,
      },
      {
        id: 'plans',
        title: 'Plan management',
        description: 'Defines how agents create, update, and interpret files in the project .plans directory.',
        content: PLAN_MANAGEMENT_INSTRUCTIONS,
      },
      {
        id: 'scope',
        title: 'Conversation scope',
        description: 'Keeps the harness useful for both software work and harmless general questions.',
        content: CONVERSATION_SCOPE_INSTRUCTIONS,
      },
    ],
    assemblyOrder: [
      'Built-in guardrails',
      'Per-agent persona or system prompt, when configured',
      'Additional shared project context from this settings screen',
      'Relevant project plans and documents',
      'Report-delivery instructions',
      'Plan-management and conversation-scope instructions',
      'Simulator and reference-directory context when relevant',
    ],
  };
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
 *   5. Report Delivery instructions
 *   6. Plan Management instructions (so the agent knows .plans/* is special)
 *   7. Default iOS simulator (if set and cwd looks iOS-ish)
 *   8. Reference directories
 */
export const promptBuilderService = {
  build(agentInfo: AgentInfo, sharedContext: string): PromptBuildResult {
    const parts: string[] = [DEFAULT_GUARDRAILS];

    if (agentInfo.systemPrompt) {
      parts.push(`Agent Persona:\n${agentInfo.systemPrompt}`);
    }
    const additionalProjectContext = normalizeSharedProjectContext(sharedContext);
    if (additionalProjectContext) {
      parts.push(`Additional Project Context:\n${additionalProjectContext}`);
    }
    const docsContext = documentService.getDocumentsForAgent(agentInfo.id, agentInfo.workspaceId, agentInfo.cwd);
    if (docsContext) {
      parts.push(docsContext);
    }
    parts.push(REPORT_DELIVERY_INSTRUCTIONS);
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

    return {
      appendedSystemPrompt: parts.join('\n\n'),
      validReferencePaths,
    };
  },
};
