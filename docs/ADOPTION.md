# Rolling out parallel coding agents on a team

Start with one engineer supervising two bounded tasks. The useful unit is a reviewed change with reproducible checks, not an agent running unattended. Forge keeps conversations, terminals and project state together; it does not grant permission to merge or deploy.

## Week 1 — learn the supervision loop

Run `bun run demo` without accounts. Agree on repository instructions, commands that prove success, and which data may be sent to providers. Pick one small UI change and one independent test/documentation task. Create a separate Git worktree for each writer, add both to one workspace, and give each a goal, owned files and a stopping point.

**Human approval:** the repository owner approves provider/data policy and budget before enabling live agents. The supervising engineer approves the task split and checks for overlapping files. Commit or branch the baseline. Provider permission prompts are disabled; use recoverable checkouts and an appropriate OS/container boundary.

## Week 2 — compare against the existing workflow

Try two or three parallel tasks on ordinary changes. Keep scope small enough that a reviewer can read every diff. Use terminals to run actual checks; review usage after each finished run. Track review minutes, escaped defects, duplicate work, merge conflicts and reported spend. Unknown cost stays unknown. Reconnect/stop/retry once deliberately so the team understands recovery and queued messages.

**Human approval:** a reviewer inspects the diff and independently runs the agreed checks before integrating each branch. Agents may propose fixes or tests, but a “done” message is not test evidence. Do not let two writers share a worktree merely because their panes are separate.

## Week 3 — make the practice repeatable

Publish a short task template: context, allowed files, acceptance checks, budget, escalation conditions. Add a reviewer role and a documented handoff between agents. Keep CI as the common gate. Establish provider-side spending controls and a process for stopping abandoned agents/servers. Expand concurrency only when review load stays manageable.

**Human approval:** a team lead reviews the pilot data and chooses the next scope. Merges, external writes and releases remain explicit human decisions. Pause expansion if review time rises, agent claims cannot be reproduced, or parallel work causes repeated conflicts.

The [failure-mode map](FAILURE-MODES.md) identifies enforced safeguards and behavioral guidance. [Workspace ADR](decisions/001-workspaces.md) explains why per-agent queues do not provide filesystem isolation.
