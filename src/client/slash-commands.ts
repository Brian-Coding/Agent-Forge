export interface SlashCommand {
  readonly _id: string;
  readonly command: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly promptTemplate: string;
}

// Original Agent Forge prompts. Selecting a template only fills the composer;
// the person using it can edit the scope before sending it to a provider.
export const slashCommands: readonly SlashCommand[] = [
  {
    _id: 'diff-check', command: 'diff-check', name: 'Check this diff', category: 'verification',
    description: 'Find concrete defects in the current changes.',
    promptTemplate: 'Read the current Git diff and the surrounding code. List actionable defects with file locations and a way to reproduce each one. Keep files unchanged. Say which checks you could not run.',
  },
  {
    _id: 'task-map', command: 'task-map', name: 'Map the next task', category: 'planning',
    description: 'Prepare a scoped plan for review before editing.',
    promptTemplate: 'Use our latest task to draft a short plan: affected files, proposed behavior, risks, and how we will verify it. Ask about any missing requirement that changes the approach. Wait for my approval before editing.',
  },
  {
    _id: 'bug-proof', command: 'bug-proof', name: 'Capture a regression', category: 'verification',
    description: 'Turn a reported bug into a failing test.',
    promptTemplate: 'Reproduce the bug we discussed using the smallest relevant test. Show that the test fails for the reported reason, then propose a focused repair. Do not broaden the change to unrelated cleanup.',
  },
  {
    _id: 'pr-notes', command: 'pr-notes', name: 'Draft PR notes', category: 'handoff',
    description: 'Explain the diff and its validation for a reviewer.',
    promptTemplate: 'Draft a pull request description from the current diff. Explain the user-visible change, the reason for it, checks actually completed, and remaining limitations. Leave the description here for review; do not publish it.',
  },
  {
    _id: 'command-trace', command: 'command-trace', name: 'Trace a failed command', category: 'verification',
    description: 'Investigate a command failure using observed output.',
    promptTemplate: 'Investigate the failing command from our conversation. Check its working directory, prerequisites, exit status, and relevant output without exposing credentials. Separate observed facts from hypotheses and suggest the smallest next experiment.',
  },
  {
    _id: 'preview-check', command: 'preview-check', name: 'Check a local preview', category: 'verification',
    description: 'Check the expected local URL and listener.',
    promptTemplate: 'Check the local preview we are working on. Identify the expected URL, inspect the listener and startup output, and request the page if available. Report what responds and what remains unverified. Ask before stopping any process.',
  },
  {
    _id: 'pane-handoff', command: 'pane-handoff', name: 'Prepare a pane handoff', category: 'handoff',
    description: 'Give another agent a bounded task and current status.',
    promptTemplate: 'Write a handoff for a second Agent Forge pane: task goal, current branch and folder, files already changed, checks completed, and a bounded next step. Identify files that need a single owner to avoid conflicting edits.',
  },
  {
    _id: 'scope-check', command: 'scope-check', name: 'Check task boundaries', category: 'planning',
    description: 'Compare the work in progress with the agreed task.',
    promptTemplate: 'Compare the current changes with the task we agreed on. Call out missing requirements, unrelated edits, and assumptions that need a human decision. Leave the working tree as it is and propose a concise completion checklist.',
  },
];
