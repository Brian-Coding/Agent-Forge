import { jsonResponse } from '../utils';

export async function handleGetPorts(req: Request): Promise<Response> {
  try {
    const isWindows = process.platform === 'win32';
    const seen = new Set<string>();
    const ports: { port: number; pid: number; command: string }[] = [];

    if (isWindows) {
      const proc = Bun.spawn(['netstat', '-ano'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      if (exitCode !== 0) return jsonResponse({ ports: [] });
      const lines = stdout.trim().split('\n');
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
        let command = 'unknown';
        try {
          const nameProc = Bun.spawn(
            ['powershell', '-Command', `(Get-Process -Id ${pid}).ProcessName`],
            { stdout: 'pipe', stderr: 'pipe' },
          );
          await nameProc.exited;
          command = (await new Response(nameProc.stdout).text()).trim() || 'unknown';
        } catch {}
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
    const proc = isWindows
      ? Bun.spawn(
          ['powershell', '-Command', `Stop-Process -Id ${body.pid} -Force`],
          { stdout: 'pipe', stderr: 'pipe' },
        )
      : Bun.spawn(['kill', '-9', String(body.pid)], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
    const exitCode = await proc.exited;
    return jsonResponse({ ok: exitCode === 0 });
  } catch (e: any) {
    return jsonResponse({ ok: false, error: e.message }, 500);
  }
}
