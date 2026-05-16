import { jsonResponse } from '../utils';

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
    const proc = Bun.spawn(['tasklist', '/FO', 'CSV', '/NH'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
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

export async function handleGetPorts(req: Request): Promise<Response> {
  try {
    const isWindows = process.platform === 'win32';
    const seen = new Set<string>();
    const ports: { port: number; pid: number; command: string }[] = [];

    if (isWindows) {
      // Two spawns total: one netstat for the port→pid map, one tasklist for
      // the pid→name map. Used to be netstat + N PowerShell spawns where N is
      // the number of listening ports on the machine.
      const [netstatOut, pidToName] = await Promise.all([
        (async () => {
          const proc = Bun.spawn(['netstat', '-ano'], { stdout: 'pipe', stderr: 'pipe' });
          await proc.exited;
          return new Response(proc.stdout).text();
        })(),
        getProcessNamesByPidWindows(),
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
        const key = port + ':' + pid;
        if (seen.has(key)) continue;
        seen.add(key);
        const command = pidToName.get(pid) || 'unknown';
        ports.push({ port, pid, command });
      }
    } else {
      const proc = Bun.spawn(['lsof', '-iTCP', '-sTCP:LISTEN', '-nP'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      if (exitCode !== 0) return jsonResponse({ ports: [] });
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
        const key = port + ':' + pid;
        if (seen.has(key)) continue;
        seen.add(key);
        ports.push({ port, pid, command });
      }
    }

    ports.sort((a, b) => a.port - b.port);
    return jsonResponse({ ports });
  } catch {
    return jsonResponse({ ports: [] });
  }
}

export async function handleKillPort(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { pid: number };
    if (!body.pid) return jsonResponse({ error: 'Missing pid' }, 400);
    const isWindows = process.platform === 'win32';
    // taskkill is a native Win32 exe — same role as PowerShell's
    // Stop-Process but without paying PowerShell's ~1-2s cold-start tax.
    const proc = isWindows
      ? Bun.spawn(['taskkill', '/F', '/PID', String(body.pid)], { stdout: 'pipe', stderr: 'pipe' })
      : Bun.spawn(['kill', '-9', String(body.pid)], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    return jsonResponse({ ok: exitCode === 0 });
  } catch (e: any) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}
