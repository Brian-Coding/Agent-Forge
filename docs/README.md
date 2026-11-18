# Agent Forge documentation

Start with **[Getting started](getting-started.md)** if this is your first time.

## Using Agent Forge

- [Getting started](getting-started.md): install, first workspace, first agent.
- [Workspaces and agents](workspaces-and-agents.md): grid layout, providers, models, reasoning levels, personas, reference folders.
- [Chat, plans, and shared instructions](chat-and-instructions.md): messages, images, queued follow-ups, slash commands, `.plans/`, and how agent context is assembled.
- [Terminals, ports, Git, and simulators](tools.md): the tools around each agent pane.
- [Usage and limits](usage-and-limits.md): token history and provider rate-limit windows.
- [Configuration](configuration.md): ports, environment variables, and where state is stored.
- [Windows launcher](windows-launcher.md): desktop and sign-in shortcuts on Windows.

## Trust and internals

- [Safety model](safety.md): what Agent Forge protects, and what it deliberately does not.
- [Architecture](architecture.md): how the server, adapters, and browser UI fit together.
- [Failure modes](FAILURE-MODES.md): safeguards, regression tests, and remaining gaps.
- [Architecture decisions](decisions/README.md): concurrency, process ownership, and local authorization.
- [Team adoption](ADOPTION.md): bounded tasks, human approval, and pilot measurements.
- [Claude CLI compatibility fixtures](provider-compatibility/claude/README.md): captured CLI output shapes used by the auth classifier tests.
- [Demo and media](media.md): reproduce the account-free workflow and recordings.
- [Performance](performance.md): local measurements and reproduction commands.

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [AGENTS.md](../AGENTS.md).
