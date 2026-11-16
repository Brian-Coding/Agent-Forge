import { randomUUID } from 'node:crypto';
import { createProcessProbe, type ProcessIdentity } from '../platform/process-probe';
import { jsonResponse } from '../utils';
import { readJsonBody } from '../request-body';
import { collectBoundedProcess } from '../services/bounded-subprocess';
import { killProcessTree } from '../utils';
import { workspaceService } from '../services/workspace.service';
import { parseServerPort } from '../server-config';
import {
  labelListeningPort,
} from '../services/port-labels';

async function runPortCommand(args: string[], maxChars = 2 * 1024 * 1024) {
  const proc = Bun.spawn(args, { detached: process.platform !== 'win32', stdout: 'pipe', stderr: 'pipe' });
  const result = await collectBoundedProcess(proc, {
    timeoutMs: 5_000,
    terminationTimeoutMs: 2_000,
    maxChars,
    retainOutput: 'head',
    label: `Port inspection command ${args[0] || '<unknown>'}`,
    terminate: () => killProcessTree(proc),
  });
  if (result.timedOut || result.error) throw new Error(result.error || 'Port inspection timed out');
  return result;
}

/**
 * Resolve every running PID → image-name in ONE shell-out using tasklist.
 * Previous implementation spawned a PowerShell per listening port, which on
 * Windows means 50-100 PowerShell processes per poll (and SidebarPorts polls
 * every 10 seconds). PowerShell's cold-start is ~1-2s; the overlapping
 * spawns pegged CPU at 70%+ while the UI sat idle.
 *
 * tasklist is a native Win32 binary, ~10ms startup, CSV-friendly output.
 */
async function getProcessNamesByPidWindows(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const result = await runPortCommand(['tasklist', '/FO', 'CSV', '/NH']);
    if (result.exitCode !== 0) return map;
    const out = result.stdout;
    for (const line of out.split('\n')) {
      // Format: "image.exe","pid","Console","1","12,345 K"
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (!m) continue;
      const name = m[1]!.replace(/\.exe$/i, '');
      const pid = parseInt(m[2]!, 10);
      if (!isNaN(pid)) map.set(pid, name);
    }
  } catch {
    // Best-effort. Callers fall back to 'unknown' for any PID not in the map.
  }
  return map;
}

function listenPort(): number | undefined {
  try {
    return parseServerPort(process.env.PORT);
  } catch {
    return undefined;
  }
}

async function decoratePorts(
  ports: { port: number; pid: number; command: string }[],
  commandLines: Map<number, string>,
) {
  const workspaces = workspaceService.getAll();
  const serverPort = listenPort();
  return Promise.all(ports.map(async port => {
    const labeled = labelListeningPort({
      ...port,
      commandLine: commandLines.get(port.pid) || '',
      workspaces,
      listenPort: serverPort,
      selfPid: process.pid,
    });
    const observed = await portProbe.probe(port.pid);
    const stopToken = observed.status === 'matched' && observed.identity?.startTimeMs && !labeled.self
      ? randomUUID() : undefined;
    if (stopToken) stopTickets.set(stopToken, { port: port.port, identity: observed.identity!, expires: Date.now() + 30_000 });
    for (const [key, ticket] of stopTickets) if (ticket.expires < Date.now()) stopTickets.delete(key);
    return { ...port, label: labeled.label, self: labeled.self, stopToken };
  }));
}

// OS services and always-on consumer apps whose listeners are never the
// user's dev servers. Killing these from the sidebar would also be a footgun
// (taskkill /F on svchost can blue-screen-adjacent break the session).
const WINDOWS_SYSTEM_IMAGES = new Set([
  'svchost', 'System', 'Idle', 'lsass', 'services', 'wininit', 'winlogon',
  'csrss', 'smss', 'spoolsv', 'dasHost', 'SearchIndexer', 'SearchHost',
  'fontdrvhost', 'dwm', 'sihost', 'OneDrive', 'msedgewebview2', 'Widgets',
  'Discord', 'DiscordPTB', 'DiscordCanary', 'Spotify', 'steam',
  'NVIDIA Web Helper', 'nvcontainer', 'jhi_service', 'wslservice',
].map(s => s.toLowerCase()));

// Listeners in the OS dynamic/ephemeral range are auto-assigned IPC and
// helper sockets (VS Code extension hosts, Electron apps, language servers),
// not servers anyone started on purpose. Dev servers live on chosen ports.
const EPHEMERAL_PORT_START = process.platform === 'win32' ? 49152 : 32768;

export async function handleGetPorts(req: Request): Promise<Response> {
  try {
    const isWindows = process.platform === 'win32';
    const seen = new Set<string>();
    const ports: { port: number; pid: number; command: string }[] = [];

    if (isWindows) {
      // Three bounded spawns: netstat, tasklist, and one command-line table.
      // Used to be netstat + N PowerShell spawns where N is the number of
      // listening ports on the machine.
      const [netstatOut, pidToName, commandLines] = await Promise.all([
        (async () => {
          const result = await runPortCommand(['netstat', '-ano']);
          if (result.exitCode !== 0) throw new Error(result.stderr || 'netstat failed');
          return result.stdout;
        })(),
        getProcessNamesByPidWindows(),
        Promise.resolve(new Map<number, string>()),
      ]);

      const lines = netstatOut.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
        const addrMatch = parts[1]!.match(/:(\d+)$/);
        if (!addrMatch) continue;
        const port = parseInt(addrMatch[1]!, 10);
        const pid = parseInt(parts[4]!, 10);
        if (isNaN(pid) || pid === 0) continue;
        if (port >= EPHEMERAL_PORT_START) continue;
        const key = port + ':' + pid;
        if (seen.has(key)) continue;
        seen.add(key);
        const command = pidToName.get(pid) || 'unknown';
        if (WINDOWS_SYSTEM_IMAGES.has(command.toLowerCase())) continue;
        ports.push({ port, pid, command });
      }
      ports.sort((a, b) => a.port - b.port);
      return jsonResponse({ ports: await decoratePorts(ports, commandLines) });
    } else {
      const [result, commandLines] = await Promise.all([
        runPortCommand(['lsof', '-iTCP', '-sTCP:LISTEN', '-nP']),
        Promise.resolve(new Map<number, string>()),
      ]);
      if (result.exitCode !== 0) return jsonResponse({ ports: [] });
      const stdout = result.stdout;
      const lines = stdout.trim().split('\n').slice(1);
      const SYSTEM_PROCESSES = new Set([
        'ControlCe', 'rapportd', 'AirPlayXPC', 'sharingd',
        'remoted', 'identitys', 'WiFiAgent', 'bluetoothd',
      ]);
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 9) continue;
        const command = parts[0]!;
        if (SYSTEM_PROCESSES.has(command)) continue;
        const pid = parseInt(parts[1]!, 10);
        const nameField = parts[8]!;
        const portMatch = nameField.match(/:(\d+)$/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1]!, 10);
        if (port >= EPHEMERAL_PORT_START) continue;
        const key = port + ':' + pid;
        if (seen.has(key)) continue;
        seen.add(key);
        ports.push({ port, pid, command });
      }
      ports.sort((a, b) => a.port - b.port);
      return jsonResponse({ ports: await decoratePorts(ports, commandLines) });
    }
  } catch {
    return jsonResponse({ ports: [] });
  }
}

const portProbe = createProcessProbe();
const stopTickets = new Map<string, { port: number; identity: ProcessIdentity; expires: number }>();

export function sameListenerIdentity(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && !!a.startTimeMs && a.startTimeMs === b.startTimeMs && !!a.name && a.name === b.name;
}

export async function handleKillPort(req: Request): Promise<Response> {
  try {
    const body = (await readJsonBody(req, 4_096)) as { pid?: unknown; port?: unknown; stopToken?: unknown };
    const pid = parseKillPid(body.pid);
    if (pid === null || pid === process.ppid) return jsonResponse({ error: 'Invalid or unsafe pid' }, 400);
    const ticket = typeof body.stopToken === 'string' ? stopTickets.get(body.stopToken) : undefined;
    if (!ticket || ticket.expires < Date.now() || ticket.port !== body.port || ticket.identity.pid !== pid) {
      return jsonResponse({ error: 'Refresh the port list before stopping this listener' }, 409);
    }
    stopTickets.delete(body.stopToken as string);
    // Re-inventory listeners, then re-probe birth identity immediately before the signal.
    const inventory = await (await handleGetPorts(new Request(req.url))).json() as any;
    if (!inventory.ports.some((item: any) => item.pid === pid && item.port === ticket.port && !item.self)) {
      return jsonResponse({ error: 'This process no longer owns the selected listener' }, 409);
    }
    const current = await portProbe.probe(pid);
    if (current.status !== 'matched' || !current.identity || !sameListenerIdentity(ticket.identity, current.identity)) {
      return jsonResponse({ error: 'The listener process changed; stop was refused' }, 409);
    }
    // Explicit external-process stop: this is not an ownership claim or tree cleanup.
    const result = await runPortCommand(process.platform === 'win32'
      ? ['taskkill', '/F', '/PID', String(pid)] : ['kill', '-TERM', String(pid)], 64_000);
    return jsonResponse({ ok: result.exitCode === 0, scope: 'external-process',
      ...(result.exitCode === 0 ? {} : { error: 'Process termination failed' }) });
  } catch {
    return jsonResponse({ ok: false, error: 'Could not revalidate or stop the listener' }, 500);
  }
}

/** Reject values that could target a process group, this server, or PID 1. */
export function parseKillPid(value: unknown): number | null {
  if (!Number.isSafeInteger(value) || (value as number) <= 1 || value === process.pid) return null;
  return value as number;
}
