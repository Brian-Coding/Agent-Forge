# Terminals, ports, Git, and simulators

## Terminals

Each agent pane can run commands in its working folder: dev servers, test runs, builds. Output streams into the pane and the process is tracked, so it is stopped when you kill the terminal, remove the agent, or shut Agent Forge down. Commands run through your shell (`$SHELL` on macOS/Linux, `cmd.exe` on Windows).

## File changes and Git

When an agent edits files, the pane lists what changed. Click a file to open its Git diff. The header shows the current branch of the agent's folder. Agent Forge only reads Git state; it never commits or pushes on your behalf (and the built-in guardrails tell agents not to either, unless you ask).

## Machine ports

The **Machine ports** panel at the bottom of the sidebar lists processes listening on local ports and labels them when it can (for example "Vite · My App", or a workspace name when the port matches its App URL). You can stop a listed process from there. Agent Forge refuses to target PID 1, process groups, or itself.

## iOS simulators (macOS)

The **Emulators** sidebar lists Xcode simulators and can boot, shut down, or erase them, and clean Xcode's DerivedData. Pick a default simulator and agents working in iOS-looking projects are told which one to use. This needs Xcode's `xcrun simctl`; on other platforms the panel simply shows nothing.
