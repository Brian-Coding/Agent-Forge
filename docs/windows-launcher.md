# Windows launcher

Agent Forge includes an optional Windows launcher that gives you a desktop shortcut and starts Forge when you sign in. The current validation is on Linux; the Windows launcher still needs native validation.

## Install

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows-launcher.ps1
```

This creates two shortcuts, both pointing at `scripts/start-agent-forge.ps1`:

- **Desktop → Agent Forge**: start or restart Agent Forge.
- **Startup → Agent Forge**: start Agent Forge when you sign in.

The installer refuses to overwrite an unrelated shortcut with the same name.

## What the launcher does

1. Opens a visible PowerShell window that owns the server process, so you can always see and close it.
2. If an Agent Forge server from this checkout is already running, verifies it is really ours (repository lock, Bun executable, command line, process start time, and lock token) before asking it to shut down. It waits up to 20 seconds for a graceful exit, then re-checks before force-stopping a stuck server tree.
3. Starts the new server and waits for it to report the port it actually bound.
4. Opens that URL in your default browser.

Unrelated programs on the same port are never stopped; Agent Forge simply binds the next free port. Restarting interrupts any agent turn that is running.

## Options

- `-NoBrowser`: start the server without opening a browser.
- `AGENT_FORGE_CHROME_PROFILE`: set this environment variable to the display name of a Chrome profile to open Agent Forge in a new window of that profile instead of the default browser.

## Notes

- The repository must stay where it was when you ran the installer. If you move it, run the installer again.
- Windows can briefly hide a process's command line while it exits. The launcher retries that check a bounded number of times and refuses to stop a process whose ownership it cannot confirm.
- `scripts/test-windows-launcher.ps1` exercises the restart path end to end on a Windows machine.
