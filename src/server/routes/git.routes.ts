import { jsonResponse } from '../utils';

export async function handleGitBranch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  if (!path) return jsonResponse({ branch: null });
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: path,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return jsonResponse({ branch: null });
    const stdout = await new Response(proc.stdout).text();
    return jsonResponse({ branch: stdout.trim() || null });
  } catch {
    return jsonResponse({ branch: null });
  }
}
