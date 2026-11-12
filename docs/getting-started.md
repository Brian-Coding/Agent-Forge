# Getting started

## 1. Install the prerequisites

- **Bun 1.3+**: <https://bun.sh/>
- **A provider CLI**, installed and signed in. Agent Forge does not handle provider accounts itself; it drives the CLIs you already use.
  - Claude Code: install it, then run `claude` once and sign in.
  - Codex CLI: install it, then run `codex` once and sign in.

Check that they work from the same shell you will start Agent Forge from:

```bash
bun --version
claude --version   # if you use Claude
codex --version    # if you use Codex
```

## 2. Install and start

```bash
git clone https://github.com/Brian-Coding/AI-Agent-Forge.git
cd AI-Agent-Forge
bun install
bun run dev
```

The server prints the URL it bound, normally `http://localhost:3333`. If that port is busy it tries the next seven ports. Open the URL in your browser.

## 3. Create a workspace

A workspace is a project plus a grid of agent panes.

1. In the **Workspaces** sidebar, click **+ New Workspace**.
2. Give it a name and choose the project folder. New agents in this workspace start in that folder.
3. Optional: set the **App URL** (for example `http://localhost:5173`) so you have a one-click link to the app you are working on.

## 4. Add an agent

1. Click **+ Add Agent** in an empty grid slot (or press `Ctrl+N`).
2. Pick a provider (Claude or Codex), a model, and a reasoning level.
3. Optionally add a persona/system prompt and extra **reference folders** the agent may read.
4. Send a message.

You will see live progress while the agent works: its current activity, any "thinking" text the provider streams, elapsed time, and the files it changed. Press `Esc` in a pane, or click **Stop turn**, to stop the current turn.

## 5. Next steps

- Add a second agent next to the first and give them different jobs.
- Open **Settings** (gear icon) to read the built-in instructions every agent receives and add your own shared project instructions.
- Put plan files in your project's `.plans/` folder; agents see them automatically. See [Chat, plans, and shared instructions](chat-and-instructions.md).
- Read the [safety model](safety.md) before pointing agents at anything important.

## Stopping Agent Forge

Press `Ctrl+C` in the terminal running the server. Agent Forge shuts down the agent processes it started, saves its state, and releases its lock. The **☠** button in the activity bar force-kills every agent CLI process it owns if something is stuck.
