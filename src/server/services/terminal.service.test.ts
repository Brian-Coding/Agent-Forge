import { afterAll, afterEach, beforeAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '../../shared/protocol';
import { clients } from '../broadcast';
import { persistenceService } from './persistence.service';
import { terminalService } from './terminal.service';

const messages: ServerMessage[] = [];
const tracked: number[] = [];
const untracked: number[] = [];
const fakeClient = {
  send(payload: string) {
    messages.push(JSON.parse(payload));
  },
};
const originalTrackPid = persistenceService.trackPid;
const originalUntrackPid = persistenceService.untrackPid;

setDefaultTimeout(15_000);

function quoteShellPath(value: string): string {
  return process.platform === 'win32'
    ? `"${value.replace(/"/g, '""')}"`
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms; messages=${JSON.stringify(messages)}; terminals=${JSON.stringify(terminalService.getAll())}`);
    }
    await Bun.sleep(10);
  }
}

async function scriptCommand(directory: string, source: string, name = 'fixture script.js'): Promise<string> {
  const scriptDirectory = join(directory, 'path with spaces');
  await mkdir(scriptDirectory, { recursive: true });
  const script = join(scriptDirectory, name);
  await writeFile(script, source, 'utf8');
  const executable = process.platform === 'win32' ? process.execPath : quoteShellPath(process.execPath);
  return `${executable} ${quoteShellPath(script)}`;
}

beforeAll(() => {
  clients.add(fakeClient as any);
  persistenceService.trackPid = pid => { tracked.push(pid); };
  persistenceService.untrackPid = pid => { untracked.push(pid); };
});

beforeEach(() => {
  messages.length = 0;
  tracked.length = 0;
  untracked.length = 0;
});

afterEach(async () => {
  await terminalService.killAll();
  terminalService.clearAll();
});

afterAll(() => {
  clients.delete(fakeClient as any);
  persistenceService.trackPid = originalTrackPid;
  persistenceService.untrackPid = originalUntrackPid;
});

test('a real child supports spaced paths, cwd, stdout, stderr, and nonzero exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-terminal-'));
  try {
    const command = await scriptCommand(directory, [
      `process.stdout.write('cwd=' + process.cwd() + '\\nstdout-only\\n');`,
      `process.stderr.write('stderr-only\\n');`,
      `process.exitCode = 7;`,
    ].join('\n'));
    const terminal = await terminalService.create('agent-1', directory, command);
    await waitFor(() => messages.some(message =>
      message.type === 'terminal_exited' && message.terminalId === terminal.id));
    await waitFor(() => messages.filter(message =>
      message.type === 'terminal_output' && message.terminalId === terminal.id).length >= 2);

    const output = messages
      .filter((message): message is Extract<ServerMessage, { type: 'terminal_output' }> =>
        message.type === 'terminal_output' && message.terminalId === terminal.id)
      .map(message => message.content)
      .join('');
    expect(output).toContain(`cwd=${directory}`);
    expect(output).toContain('stdout-only');
    expect(output).toContain('stderr-only');
    expect(messages.filter(message => message.type === 'terminal_exited' && message.terminalId === terminal.id))
      .toEqual([{ type: 'terminal_exited', terminalId: terminal.id, exitCode: 7 }]);
    expect(tracked).toHaveLength(1);
    expect(untracked).toEqual(tracked);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('killing a long-running child emits one exit callback and performs PID cleanup once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-terminal-kill-'));
  try {
    const command = await scriptCommand(directory, `process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`);
    const terminal = await terminalService.create('agent-1', directory, command);
    await waitFor(() => messages.some(message =>
      message.type === 'terminal_output' && message.terminalId === terminal.id && message.content.includes('ready')));

    expect(await terminalService.kill(terminal.id)).toBe(true);
    await Bun.sleep(25);

    expect(messages.filter(message => message.type === 'terminal_exited' && message.terminalId === terminal.id)).toHaveLength(1);
    expect(untracked).toEqual(tracked);
    expect(terminalService.getAll().some(item => item.id === terminal.id)).toBe(false);
    expect(await terminalService.kill(terminal.id)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('killAll terminates simultaneous children without duplicate completion or stale sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-terminal-all-'));
  try {
    const command = await scriptCommand(directory, `process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`);
    const terminals = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      terminalService.create(`agent-${index}`, directory, command)));
    await waitFor(() => messages.filter(message =>
      message.type === 'terminal_output' && message.content.includes('ready')).length === 3);

    await terminalService.killAll();
    await Bun.sleep(25);

    expect(terminalService.getAll()).toEqual([]);
    for (const terminal of terminals) {
      expect(messages.filter(message => message.type === 'terminal_exited' && message.terminalId === terminal.id)).toHaveLength(1);
    }
    expect(new Set(untracked)).toEqual(new Set(tracked));
    expect(untracked).toHaveLength(tracked.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('huge stdout is broadcast in bounded chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-forge-terminal-huge-'));
  try {
    const command = await scriptCommand(directory, `process.stdout.write('x'.repeat(250000));`);
    const terminal = await terminalService.create('agent-1', directory, command);
    await waitFor(() => messages.some(message =>
      message.type === 'terminal_exited' && message.terminalId === terminal.id));
    await waitFor(() => messages
      .filter((message): message is Extract<ServerMessage, { type: 'terminal_output' }> =>
        message.type === 'terminal_output' && message.terminalId === terminal.id)
      .reduce((sum, message) => sum + message.content.length, 0) === 250_000);
    const chunks = messages.filter((message): message is Extract<ServerMessage, { type: 'terminal_output' }> =>
      message.type === 'terminal_output' && message.terminalId === terminal.id);
    expect(Math.max(...chunks.map(message => message.content.length))).toBeLessThanOrEqual(64_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
