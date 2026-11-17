export interface ListeningPort { port: number; pid: number; command: string }

/** `ss -ltnpH` contains executable names and PIDs, never command arguments. */
export function parseSsListeners(stdout: string): ListeningPort[] {
  const ports = new Map<string, ListeningPort>();
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'LISTEN') continue;
    const port = Number(fields[3]?.match(/:(\d+)$/)?.[1]);
    if (!Number.isInteger(port) || port < 1 || port >= 32768) continue;
    for (const match of line.matchAll(/\("([^"\r\n]+)",pid=(\d+),/g)) {
      const pid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      ports.set(`${port}:${pid}`, { port, pid, command: match[1]! });
    }
  }
  return [...ports.values()].sort((a, b) => a.port - b.port);
}
