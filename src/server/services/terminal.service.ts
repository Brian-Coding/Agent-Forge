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
}

// HMR-safe state
const terminals: Map<string, ManagedTerminal> = (globalThis as any).__terminalsMap ??= new Map<string, ManagedTerminal>();

export const terminalService = {
  getAll(): TerminalSession[] {
    return Array.from(terminals.values()).map(t => t.info);
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
      const spawnArgs = ['sh', '-c', command];
      assertArgvWithinLimit(spawnArgs);
      const proc = Bun.spawn(spawnArgs, {
        cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const managed: ManagedTerminal = { info, process: proc, outputBuffer: '' };
      terminals.set(id, managed);
      if (proc.pid) persistenceService.trackPid(proc.pid);

      // Stream stdout/stderr
      const readStream = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            managed.outputBuffer += text;
            if (managed.outputBuffer.length > MAX_OUTPUT_BUFFER) {
              managed.outputBuffer = managed.outputBuffer.slice(-MAX_OUTPUT_BUFFER);
            }
            broadcast({ type: 'terminal_output', terminalId: id, content: text });
          }
        } catch {
        } finally {
          reader.releaseLock();
        }
      };

      readStream(proc.stdout).catch(e => console.error(`Terminal ${id} stdout error:`, e));
      readStream(proc.stderr).catch(e => console.error(`Terminal ${id} stderr error:`, e));

      // Handle exit
      proc.exited.then((exitCode) => {
        if (proc.pid) persistenceService.untrackPid(proc.pid);
        managed.info.status = 'stopped';
        broadcast({ type: 'terminal_exited', terminalId: id, exitCode });
      }).catch(e => console.error(`Terminal ${id} exit error:`, e));

      return info;
    } catch (e: any) {
      throw new Error('Failed to spawn terminal: ' + (e.message || 'unknown error'));
    }
  },

  async kill(id: string): Promise<boolean> {
    const terminal = terminals.get(id);
    if (!terminal) return false;
    const pid = terminal.process.pid;
    await killProcessTree(terminal.process);
    if (pid) persistenceService.untrackPid(pid);
    terminal.info.status = 'stopped';
    terminals.delete(id);
    return true;
  },

  async killAll(): Promise<void> {
    const kills: Promise<void>[] = [];
    for (const [, terminal] of terminals) {
      const pid = terminal.process.pid;
      kills.push(killProcessTree(terminal.process).then(() => {
        if (pid) persistenceService.getActivePids().delete(pid);
      }));
    }
    await Promise.race([
      Promise.all(kills),
      new Promise<void>(resolve => setTimeout(resolve, 3000)),
    ]);
  },

  /** Reset all terminal statuses (for kill-all) */
  clearAll(): void {
    for (const terminal of terminals.values()) {
      terminal.info.status = 'stopped';
      broadcast({ type: 'terminal_exited', terminalId: terminal.info.id, exitCode: null });
    }
    terminals.clear();
  },
};
