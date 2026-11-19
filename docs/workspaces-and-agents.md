# Workspaces and agents

## Workspaces

A workspace groups:

- a **project folder** that new agents inherit,
- a **grid** of agent panes (1–4 columns × 1–3 rows, set from the bottom bar),
- an optional **App URL** for the app you are building, shown as an **Open** link and used to label that port in the ports list.

Switch workspaces from the sidebar. Drag the `⋮⋮` handle to reorder them, double-click a name to rename it, and delete a workspace with `×` (its agents move to another workspace). The active workspace is remembered per browser tab, so two tabs can look at different workspaces.

In a folder picker, type to filter the current list, or paste an absolute path (including `~/…`) and press **Enter** to navigate. Use **↑ ..** to move to the parent folder, including above your home folder, then **Select** to choose the current folder.

## Agents

Each agent is one provider CLI session with its own:

- **Provider**: Claude Code or Codex.
- **Model** and **reasoning level**: the model list comes from the provider (and is refreshed when you open the selector). If the CLI ever runs a different model than the one you picked, the pane blocks and asks you to resolve the mismatch instead of silently continuing.
- **Working folder**: where the agent runs. Defaults to the workspace folder.
- **Reference folders**: extra directories the agent may read for context (passed to the CLI as additional directories).
- **Persona / system prompt**: optional text added to that agent's instructions.

You can switch an existing agent's provider or model mid-conversation. When the provider changes, Agent Forge feeds the new provider a bounded excerpt of the recent conversation so it can pick up where the other left off.

## Arranging panes

- Drag a pane header onto another slot to swap them.
- Lock a pane (🔒) to keep it in place while you rearrange others.
- Minimize or maximize a pane from its header.
- The **Workspaces** sidebar lists each workspace's agents with their live status; agents that failed are flagged so you can find them quickly.

## Status you can trust

Agent status comes from the server, not the browser. If the browser disconnects, panes show "status unknown" instead of guessing. A long silence from the provider is flagged as possibly stalled, but Agent Forge does not stop long-running work on its own unless you configure an inactivity limit (see [Configuration](configuration.md)).
