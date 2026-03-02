import type { Subprocess } from 'bun';

export function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

export function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Kill an entire process tree on Windows using taskkill /T /F
export async function treeKill(pid: number): Promise<void> {
  try {
    const proc = Bun.spawn(['taskkill', '/T', '/F', '/PID', String(pid)], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await proc.exited;
  } catch (e) {
    console.error(`treeKill(${pid}) failed (process may already be dead):`, e);
  }
}

// Kill a Bun Subprocess's entire process tree, falling back to .kill() if no PID
export async function killProcessTree(proc: Subprocess<any, any, any>): Promise<void> {
  if (proc.pid) {
    await treeKill(proc.pid);
  } else {
    try { proc.kill(); } catch {}
  }
}
