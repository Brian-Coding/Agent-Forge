import type { Subprocess } from 'bun';
import type { TerminalSession } from '../../shared/protocol';
import { generateId, killProcessTree, assertArgvWithinLimit } from '../utils';
import { persistenceService } from './persistence.service';
import { broadcast } from '../broadcast';

const MAX_OUTPUT_BUFFER = 2_000_000;

interface ManagedTerminal {
  info: TerminalSession;
  process: Subprocess<'ignore', 'pipe', 'pipe'>;
  outputBuffer: string;
  finalized: boolean;
  suppressOutput: boolean;
  pidTracked: boolean;
}

// HMR-safe state
const terminals: Map<string, ManagedTerminal> = (globalThis as any).__terminalsMap ??= new Map<string, ManagedTerminal>();

const MAX_BROADCAST_CHARS = 64_000;

function untrackPidOnce(terminal: ManagedTerminal): void {
  const pid = terminal.process.pid;
  if (!terminal.pidTracked || !pid) return;
  terminal.pidTracked = false;
  persistenceService.untrackPid(pid);
}

function emitOutput(terminal: ManagedTerminal, content: string): void {
  if (!content || terminal.suppressOutput) return;
  terminal.outputBuffer += content;
  if (terminal.outputBuffer.length > MAX_OUTPUT_BUFFER) {
    terminal.outputBuffer = terminal.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
  }
  for (let offset = 0; offset < content.length; offset += MAX_BROADCAST_CHARS) {
    broadcast({
      type: 'terminal_output',
      terminalId: terminal.info.id,
      content: content.slice(offset, offset + MAX_BROADCAST_CHARS),
    });
  }
}

function finalizeTerminal(
  terminal: ManagedTerminal,
  exitCode: number | null,
  remove: boolean,
  suppressOutput = false,
): void {
  if (suppressOutput) terminal.suppressOutput = true;
  if (!terminal.finalized) {
    terminal.finalized = true;
    terminal.info.status = 'stopped';
    broadcast({ type: 'terminal_exited', terminalId: terminal.info.id, exitCode });
  }
  if (remove) terminals.delete(terminal.info.id);
}

function getShellCommand(command: string): string[] {
  if (process.platform === 'win32') {
    // `/s` rewrites quote boundaries and truncates arguments whose paths
    // contain spaces (for example `bun "C:\\repo path\\script.js"`). Bun
    // already passes the command as one argv element, so `/d /c` preserves
    // the user's quoting while still disabling cmd.exe AutoRun hooks.
    return [process.env.ComSpec || 'cmd.exe', '/d', '/c', command];
  }
  return [process.env.SHELL || 'sh', '-c', command];
}

export const terminalService = {
  getAll(): TerminalSession[] {
    return Array.from(terminals.values()).map(t => ({ ...t.info }));
  },

  async create(agentId: string, cwd: string, command: string): Promise<TerminalSession> {
    const id = generateId();
    const info: TerminalSession = {
      id,
      agentId,
      command,
      cwd,
      status: 'running',
      createdAt: Date.now(),
    };

    try {
      const spawnArgs = getShellCommand(command);
      assertArgvWithinLimit(spawnArgs);
      const proc = Bun.spawn(spawnArgs, {
        cwd,
        detached: process.platform !== 'win32',
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        // cmd.exe parses its post-/c tail itself. Letting Bun quote that tail
        // a second time turns embedded path quotes into literal characters.
        windowsVerbatimArguments: process.platform === 'win32',
      });

      const managed: ManagedTerminal = {
        info,
        process: proc,
        outputBuffer: '',
        finalized: false,
        suppressOutput: false,
        pidTracked: !!proc.pid,
      };
      terminals.set(id, managed);
      if (proc.pid) persistenceService.trackPid(proc.pid);

      // Stream stdout/stderr
      const readStream = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let completed = false;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            emitOutput(managed, decoder.decode(value, { stream: true }));
          }
          completed = true;
        } finally {
          if (completed) emitOutput(managed, decoder.decode());
          reader.releaseLock();
        }
      };

      readStream(proc.stdout).catch(e => console.error(`Terminal ${id} stdout error:`, e));
      readStream(proc.stderr).catch(e => console.error(`Terminal ${id} stderr error:`, e));

      // Handle exit
      proc.exited.then(async (exitCode) => {
        const cleanup = await killProcessTree(proc);
        if (cleanup.treeKill.succeeded || process.platform === 'win32') untrackPidOnce(managed);
        finalizeTerminal(managed, exitCode, false);
      }).catch(e => {
        // Keep the PID tracked: startup recovery must retry cleanup when the
        // runtime cannot confirm that this child exited.
        finalizeTerminal(managed, null, false);
        console.error(`Terminal ${id} exit error:`, e);
      });

      return { ...info };
    } catch (e: any) {
      throw new Error('Failed to spawn terminal: ' + (e.message || 'unknown error'));
    }
  },

  async kill(id: string): Promise<boolean> {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    if (terminal.finalized) {
      terminals.delete(id);
      return true;
    }
    const pid = terminal.process.pid;
    const result = await killProcessTree(terminal.process);
    if (result.rootExited && result.treeKill.succeeded && pid) untrackPidOnce(terminal);
    // Even an unconfirmed process is detached from the UI so it cannot keep
    // emitting output. Its PID intentionally stays persisted for recovery.
    finalizeTerminal(terminal, result.exitCode, true, true);
    return result.rootExited && result.treeKill.succeeded;
  },

  async killAll(): Promise<void> {
    const ids = [...terminals.keys()];
    await Promise.allSettled(ids.map(id => terminalService.kill(id)));
  },

  /** Drop already-stopped history without duplicating exit notifications. */
  clearAll(): void {
    for (const [id, terminal] of terminals) {
      if (terminal.finalized) terminals.delete(id);
    }
  },
};
