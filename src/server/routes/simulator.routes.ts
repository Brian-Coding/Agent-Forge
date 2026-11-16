import { join } from 'path';
import { homedir } from 'os';
import { jsonResponse } from '../utils';
import { readJsonBody, RequestBodyError } from '../request-body';
import { collectBoundedProcess } from '../services/bounded-subprocess';
import { killProcessTree } from '../utils';
import { safeRemoveTree } from '../services/safe-filesystem.mjs';

export async function runSimctl(...args: string[]): Promise<{ ok: boolean; output: string }> {
  try {
    const proc = Bun.spawn(['xcrun', 'simctl', ...args], { detached: process.platform !== 'win32',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const result = await collectBoundedProcess(proc, {
      timeoutMs: 30_000,
      terminationTimeoutMs: 3_000,
      maxChars: 2 * 1024 * 1024,
      retainOutput: 'head',
      label: 'iOS simulator command',
      terminate: () => killProcessTree(proc),
    });
    if (result.timedOut || result.error) return { ok: false, output: result.error || 'Simulator command timed out' };
    return { ok: result.exitCode === 0, output: result.stdout || result.stderr };
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
  let body: any;
  try { body = await readJsonBody(req, 4_096); }
  catch (error) { return bodyError(error); }
  const udid = parseSimulatorUdid(body?.udid);
  if (!udid) return jsonResponse({ error: 'Invalid or missing udid' }, 400);
  const result = await runSimctl('boot', udid);
  return jsonResponse({ ok: result.ok, message: result.output });
}

export async function handleShutdownSimulator(req: Request): Promise<Response> {
  let body: any;
  try { body = await readJsonBody(req, 4_096); }
  catch (error) { return bodyError(error); }
  const udid = parseSimulatorUdid(body?.udid);
  if (!udid) return jsonResponse({ error: 'Invalid or missing udid' }, 400);
  const result = await runSimctl('shutdown', udid);
  return jsonResponse({ ok: result.ok, message: result.output });
}

export async function handleEraseSimulator(req: Request): Promise<Response> {
  let body: any;
  try { body = await readJsonBody(req, 4_096); }
  catch (error) { return bodyError(error); }
  const udid = parseSimulatorUdid(body?.udid);
  if (!udid) return jsonResponse({ error: 'Invalid or missing udid' }, 400);
  const result = await runSimctl('erase', udid);
  return jsonResponse({ ok: result.ok, message: result.output });
}

export function parseSimulatorUdid(value: unknown): string | null {
  if (value === 'booted') return value;
  return typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function bodyError(error: unknown): Response {
  return jsonResponse(
    { error: error instanceof Error ? error.message : 'Invalid request body' },
    error instanceof RequestBodyError ? error.status : 400,
  );
}

export async function handleCleanDerivedData(req: Request): Promise<Response> {
  if (process.platform !== 'darwin') {
    return jsonResponse({ ok: false, message: 'DerivedData cleanup is only available on macOS' }, 400);
  }

  const cleanupPaths = derivedDataCleanupPaths();
  try {
    const result = await safeRemoveTree({
      targetPath: cleanupPaths.derivedDataPath,
      allowedRoot: cleanupPaths.xcodeRoot,
      quarantineRoot: cleanupPaths.quarantineRoot,
      reason: 'Quarantine Xcode DerivedData after an explicit local UI request',
      allowNonEmpty: true,
      maxEntries: 1_000_000,
      expectedTargetName: 'DerivedData',
      protectedPaths: [cleanupPaths.home],
    });
    const message = result.status === 'dry-run'
      ? 'DerivedData cleanup passed preflight; dry-run mode left it unchanged'
      : `DerivedData moved to recoverable quarantine: ${result.path}`;
    return jsonResponse({ ok: true, message, quarantinePath: result.status === 'quarantined' ? result.path : undefined });
  } catch (e: any) {
    return jsonResponse({ ok: false, message: e.message }, 500);
  }
}

export function derivedDataCleanupPaths(home = homedir()): {
  home: string;
  xcodeRoot: string;
  derivedDataPath: string;
  quarantineRoot: string;
} {
  const xcodeRoot = join(home, 'Library', 'Developer', 'Xcode');
  return {
    home,
    xcodeRoot,
    derivedDataPath: join(xcodeRoot, 'DerivedData'),
    quarantineRoot: join(xcodeRoot, '.agent-forge-quarantine'),
  };
}
