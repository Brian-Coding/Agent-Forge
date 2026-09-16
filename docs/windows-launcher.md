# Windows launcher

Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows-launcher.ps1` to install the desktop and current-user Startup shortcuts.

The installer also disables the legacy **Agent Forge Startup** scheduled task when its single PowerShell action points to the sibling `legacy-bootstrap/start-agent-forge.ps1`. That older bootstrap launches `run-agent-forge-dev.ps1` in a hidden window and bypasses this launcher. The task definition is retained, and an unfamiliar same-name task causes installation to stop without changing the launchers. Keep that legacy task disabled: the current-user Startup shortcut is the one supported sign-in entry point. Disabling the task does not stop a server it already launched; run the desktop shortcut once to replace that instance.

At Windows sign-in, Agent Forge opens in a visible PowerShell terminal. Once the server reports its actual bound port, Chrome opens a new window using the profile named **First**. A browser cannot open before sign-in.

Double-click **Agent Forge** on the desktop to restart. The launcher verifies the repository lock, Bun executable, server command, process creation time and lock token before stopping the previous server. It requests graceful shutdown, waits up to 20 seconds, then revalidates before force-stopping a stuck or legacy server tree. Restarting interrupts active work. Unrelated port occupants are never killed; Forge can use the next available port.

Windows can briefly omit a process's command line while it exits. The launcher retries that incomplete identity a bounded number of times; it accepts a confirmed exit or a newly complete identity and refuses to kill a process whose ownership remains unverifiable.

Ctrl+C requests normal cleanup. Closing the terminal is also detected by the server's parent-identity monitor, even when Windows does not forward a close signal. Cleanup saves state and stops owned work, and can take several seconds. This is graceful cleanup, not a Windows Job Object guarantee if Bun itself is hung or forcibly killed.

Startup and desktop shortcuts use the same launcher and explicitly request a normal visible window. The repository must remain at its installed location; rerun the installer after moving it. Chrome must contain exactly one profile named First, and Bun must be on PATH. Errors stay visible in the terminal. Each run retains diagnostic stdout/stderr logs in its own fresh `AgentForge-launch-*` directory under Windows temp. No existing temporary directories are deleted.

To disable automatic launch, remove only the **Agent Forge** shortcut from the current user's Windows Startup folder through File Explorer. The desktop shortcut remains usable.
