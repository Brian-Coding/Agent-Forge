import type { TreeKillResult } from '../utils';
import { treeKill } from '../utils';

export interface WaitableNodeChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
  unref(): void;
}

export interface NodeChildTerminationResult {
  exited: boolean;
  treeKill: TreeKillResult | null;
  directKillAttempted: boolean;
  detached: boolean;
  error?: string;
}

export interface NodeChildTerminationOptions {
  treeKillTimeoutMs?: number;
  rootExitGraceMs?: number;
  finalExitGraceMs?: number;
}

export interface NodeChildTerminationDependencies {
  killTree(pid: number): Promise<TreeKillResult>;
}

function bounded(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

export function waitForNodeChildExit(child: WaitableNodeChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), bounded(timeoutMs, 0));
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    child.once('exit', onExit);
    // Cover an exit between the initial check and listener registration.
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

const defaultDependencies: NodeChildTerminationDependencies = {
  killTree: pid => treeKill(pid),
};

/** Bounded process-tree termination for node:child_process handles. */
export async function terminateNodeChildProcess(
  child: WaitableNodeChild,
  options: NodeChildTerminationOptions = {},
  dependencies: NodeChildTerminationDependencies = defaultDependencies,
): Promise<NodeChildTerminationResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exited: true, treeKill: null, directKillAttempted: false, detached: false };
  }

  const treeKillTimeoutMs = bounded(options.treeKillTimeoutMs, 2_000);
  let treeResult: TreeKillResult | null = null;
  if (Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      treeResult = await Promise.race([
        dependencies.killTree(child.pid!),
        new Promise<TreeKillResult>(resolve => {
          timer = setTimeout(() => resolve({
            attempted: true,
            succeeded: false,
            exitCode: null,
            timedOut: true,
            error: `process-tree termination timed out after ${treeKillTimeoutMs}ms`,
          }), treeKillTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (await waitForNodeChildExit(child, bounded(options.rootExitGraceMs, 500))) {
    return { exited: true, treeKill: treeResult, directKillAttempted: false, detached: false };
  }

  let error: string | undefined;
  try {
    child.kill('SIGKILL');
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  if (await waitForNodeChildExit(child, bounded(options.finalExitGraceMs, 500))) {
    return {
      exited: true,
      treeKill: treeResult,
      directKillAttempted: true,
      detached: false,
      ...(error ? { error } : {}),
    };
  }

  try { child.unref(); } catch (cause) {
    error = error || (cause instanceof Error ? cause.message : String(cause));
  }
  return {
    exited: false,
    treeKill: treeResult,
    directKillAttempted: true,
    detached: true,
    ...(error ? { error } : {}),
  };
}
