import { join } from 'path';
import { homedir } from 'os';
import { jsonResponse } from '../utils';

async function runSimctl(...args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(['xcrun', 'simctl', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { ok: exitCode === 0, output: stdout || stderr };
  } catch (e: any) {
    return { ok: false, output: e.message || 'xcrun not found. Is Xcode installed?' };
  }
}

export async function handleListSimulators(req: Request): Promise<Response> {
  const result = await runSimctl('list', 'devices', '--json');
  if (!result.ok) {
    return jsonResponse({ error: result.output, devices: {} }, 500);
  }
  try {
    const parsed = JSON.parse(result.output);
    return jsonResponse(parsed);
  } catch {
    return jsonResponse({ error: 'Failed to parse simctl output', raw: result.output }, 500);
  }
}

export async function handleBootSimulator(req: Request): Promise<Response> {
  const body = (await req.json()) as { udid: string };
  if (!body.udid) return jsonResponse({ error: 'Missing udid' }, 400);
  const result = await runSimctl('boot', body.udid);
  return jsonResponse({ ok: result.ok, message: result.output });
}

export async function handleShutdownSimulator(req: Request): Promise<Response> {
  const body = (await req.json()) as { udid: string };
  if (!body.udid) return jsonResponse({ error: 'Missing udid' }, 400);
  const result = await runSimctl('shutdown', body.udid);
  return jsonResponse({ ok: result.ok, message: result.output });
}

export async function handleEraseSimulator(req: Request): Promise<Response> {
  const body = (await req.json()) as { udid: string };
  if (!body.udid) return jsonResponse({ error: 'Missing udid' }, 400);
  const result = await runSimctl('erase', body.udid);
  return jsonResponse({ ok: result.ok, message: result.output });
}

export async function handleCleanDerivedData(req: Request): Promise<Response> {
  if (process.platform !== 'darwin') {
    return jsonResponse({ ok: false, message: 'DerivedData cleanup is only available on macOS' }, 400);
  }

  const derivedDataPath = join(homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  try {
    const { rm } = await import('node:fs/promises');
    await rm(derivedDataPath, { recursive: true, force: true });
    return jsonResponse({ ok: true, message: 'Derived data cleaned' });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e.message }, 500);
  }
}
