import type { PersistedData } from '../shared/protocol';
import index from '../client/index.html';

import { persistenceService, PERSISTED_SCHEMA_VERSION } from './services/persistence.service';
import { settingsService } from './services/settings.service';
import { workspaceService } from './services/workspace.service';
import { documentService } from './services/document.service';
import { agentService, initAgentService } from './services/agent.service';
import { terminalService } from './services/terminal.service';
import { browserService } from './services/browser.service';
import { qaService } from './services/qa.service';
import { atlasService } from './services/atlas.service';
import { usageService } from './services/usage.service';
import { limitsService } from './services/limits.service';
import { MAX_CHAT_IMAGE_TOTAL_BYTES } from './services/chat-image.service';
import {
  acquireProcessLockFile,
  processExists,
  releaseProcessLockFile,
  type ProcessLockHandle,
} from './services/process-lock';
import { collectBoundedProcess } from './services/bounded-subprocess';
import { killProcessTree } from './utils';
import { createProcessProbe } from './platform/process-probe';
import { inspectExistingServerLock, reportOccupiedPorts, waitUntilProcessMissing } from './process-startup';
import { createShutdownCoordinator } from './services/shutdown-coordinator';
import { parseServerPort } from './server-config';
import { existsSync } from 'fs';
import { monitorLauncher } from './services/launch-lifecycle';

import { websocketHandlers } from './ws';

import { handleDirectories } from './routes/directories.routes';
import { handleGetPorts, handleKillPort } from './routes/ports.routes';
import { handleGitBranch, handleGitDiff } from './routes/git.routes';
import { handleGetModels } from './routes/models.routes';
import { handleUsageExport } from './routes/usage.routes';
import { handleVercelIntegration } from './routes/integrations.routes';
import {
  handleGoogleDocsAppend,
  handleGoogleDocsDocument,
  handleGoogleDocsIntegration,
  handleGoogleDocsReplace,
} from './routes/google-docs.routes';
import { googleDocsService } from './services/google-docs.service';
import { handleHarnessInstructions } from './routes/harness.routes';
import { handleRuntimeHealth } from './routes/health.routes';
import { captureRuntimeStartup } from './services/runtime-truth';
import { handleAskAtlas } from './routes/atlas.routes';
import { handleProjectFile } from './routes/project-file.routes';
import { handleChatImage, handleChatImageUpload } from './routes/chat-image.routes';
import { handleListSimulators, handleBootSimulator, handleShutdownSimulator, handleEraseSimulator, handleCleanDerivedData } from './routes/simulator.routes';
import { handleBrowserNavigate, handleBrowserScreenshot, handleBrowserClick, handleBrowserType, handleBrowserWaitForReady, handleBrowserConsoleGet, handleBrowserConsoleClear, handleBrowserStatus, handleBrowserEvaluate, handleBrowserNetworkGet, handleBrowserNetworkClear, handleBrowserViewport, handleBrowserContextClose, handleQaScreenshot, handleAtlasFile } from './routes/browser.routes';

// --- Process lock --------------------------------------------------------
// Prevents two agent-forge bun.exe instances from clobbering the same
// data.json. The lock is cwd-relative so two checkouts in different dirs
// don't fight. A previous server is asked to exit only after a live probe
// proves it is still the recorded Bun process. Unproven PIDs are never
// force-killed.

const LOCK_FILE = './agent-forge.lock';
let processLockHandle: ProcessLockHandle | null = null;

function isPidImmediateAncestor(targetPid: number): boolean {
  if (targetPid === process.pid) return true;
  if (typeof process.ppid === 'number' && targetPid === process.ppid) return true;
  return false;
}

const processProbe = createProcessProbe();

async function acquireProcessLock(): Promise<void> {
  processLockHandle = await acquireProcessLockFile({
    path: LOCK_FILE,
    inspectExisting: owner => inspectExistingServerLock(owner, {
      probe: processProbe,
      isImmediateAncestor: isPidImmediateAncestor,
      requestGracefulExit(pid) {
        console.log(`Requesting graceful exit of previous Agent Forge PID ${pid}; force-kill is disabled.`);
        try { process.kill(pid, 'SIGINT'); } catch {}
      },
      waitForExit: (pid, timeoutMs) => waitUntilProcessMissing(pid, timeoutMs, processProbe, processExists),
    }).then(decision => {
      console.log(decision.reason || `Lock inspect ${decision.action} for PID ${owner.pid}`);
      return decision;
    }),
  });
}

async function releaseProcessLock(): Promise<void> {
  if (!processLockHandle) return;
  const handle = processLockHandle;
  processLockHandle = null;
  await releaseProcessLockFile(handle);
}

// Occupied preferred ports are reported, never force-cleared. Binding walks
// preferredPort..+7. A dead Windows socket still requires a reboot.
async function logOccupiedPreferredPorts(preferredPort: number): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const proc = Bun.spawn(['netstat', '-ano'], { stdout: 'pipe', stderr: 'pipe' });
    const result = await collectBoundedProcess(proc, {
      timeoutMs: 5_000,
      maxChars: 2 * 1024 * 1024,
      retainOutput: 'head',
      label: 'Windows port inventory',
      terminate: () => killProcessTree(proc),
    });
    if (result.timedOut || result.error || result.exitCode !== 0) return;
    const occupants = reportOccupiedPorts(result.stdout, preferredPort, preferredPort + 7, process.pid);
    if (occupants.length > 0) {
      console.warn(
        `Preferred ports ${preferredPort}-${preferredPort + 7} have live listeners (PIDs ${occupants.join(', ')}). ` +
        'They will not be killed; the server will use the next free port if bind fails.',
      );
    }
  } catch (e) {
    console.warn('Port occupancy scan failed; continuing with bind fallback:', e);
  }
}

// --- Startup: load persisted data and wire up services ---
async function init() {
  const data = await persistenceService.load();

  if (data) {
    settingsService.load(data.settings);
    // data.notes is a legacy field (Notes feature removed) — ignored on load.
    documentService.load(data.documents);
    agentService.load({
      agents: data.agents,
      messages: data.messages,
      sharedContext: data.sharedContext,
    });
    usageService.load(data.usageEvents);
  }

  // Register the collector before any migration/recovery calls saveNow(). A
  // save made without a collector is intentionally a no-op, which previously
  // left recovered QA/Atlas states and the default workspace undurable.
  persistenceService.setBuildPersistedData((): PersistedData => ({
    schemaVersion: PERSISTED_SCHEMA_VERSION,
    agents: agentService.buildPersistedAgents() as any,
    messages: agentService.buildPersistedMessages(),
    sharedContext: agentService.getSharedContext(),
    documents: documentService.buildPersistedDocuments(),
    settings: settingsService.get(),
    workspaces: workspaceService.getAll(),
    usageEvents: usageService.getEvents(),
  }));

  if (data) {
    await workspaceService.loadAndMigrate(
      data.workspaces,
      data.settings,
      data.agents.map(a => ({ id: a.id, cwd: a.cwd, workspaceId: a.workspaceId })),
      agentService.setAgentWorkspace,
    );
    console.log(`Loaded ${data.agents.length} agents, ${data.messages.length} messages, ${documentService.getAll().length} documents, ${workspaceService.getAll().length} workspaces, ${(data.usageEvents ?? []).length} usage entries from disk`);
  }

  // Wire up cross-service callbacks
  initAgentService();

  usageService.startSync();
}

// Lock FIRST — kill any prior bun.exe — THEN load data.json. If we load
// first, a still-running prior instance could mutate data.json between
// our read and our kill, and we'd save our older state on top of it.
await acquireProcessLock();

await init();
await captureRuntimeStartup();

// --- Network guard --------------------------------------------------------
// The server executes code on behalf of whoever can reach it (agents run
// with permissions bypassed, terminals run arbitrary shell commands), so the
// HTTP/WS surface must not be reachable cross-origin. Two layers:
//   1. Bind to loopback by default (HOST env opts into LAN exposure).
//   2. Reject requests whose Host/Origin isn't loopback — blocks DNS
//      rebinding and cross-site WebSocket hijacking from malicious pages
//      running in the user's own browser.

const bindHostname = process.env.HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// If the user explicitly bound a non-loopback interface, they opted into LAN
// access — skip the strict Host check (Origin check still applies).
const enforceLoopbackHost = LOOPBACK_HOSTS.has(bindHostname);

function isRequestAllowed(req: Request): boolean {
  try {
    if (enforceLoopbackHost) {
      const host = new URL(req.url).hostname;
      if (!LOOPBACK_HOSTS.has(host)) return false;
    }
    // Browsers attach Origin on WS upgrades and cross-origin fetches.
    // Non-browser clients (agent callbacks, curl) send none — allowed.
    const origin = req.headers.get('origin');
    if (origin) {
      const originHost = new URL(origin).hostname;
      if (!LOOPBACK_HOSTS.has(originHost)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// --- Server bind with port fallback -------------------------------------
// Try preferredPort first; if Windows has the socket locked (typically an
// orphan our scan missed, or a non-bun process), walk forward through
// preferredPort+1..+7 instead of failing startup. agentService.setGuiPort
// below uses whichever port we actually bound so the QA system prompt
// references the right URL even on the fallback.
function startServer(preferredPort: number) {
  const maxAttempts = 8;
  let lastErr: unknown = null;
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferredPort + i;
    try {
      return Bun.serve({
        port,
        hostname: bindHostname,
        maxRequestBodySize: MAX_CHAT_IMAGE_TOTAL_BYTES,
        routes: {
          '/': index,
        },
        fetch(req, server) {
          const url = new URL(req.url);

          if (!isRequestAllowed(req)) {
            return new Response('Forbidden', { status: 403 });
          }

          if (req.headers.get('upgrade') === 'websocket') {
            const success = server.upgrade(req, { data: {} });
            if (success) return undefined;
            return new Response('WebSocket upgrade failed', { status: 500 });
          }

          // REST routes
          if (url.pathname === '/api/directories') return handleDirectories(req);
          if (url.pathname === '/api/ports' && req.method === 'GET') return handleGetPorts(req);
          if (url.pathname === '/api/ports/kill' && req.method === 'POST') return handleKillPort(req);
          if (url.pathname === '/api/git-branch' && req.method === 'GET') return handleGitBranch(req);
          if (url.pathname === '/api/git-diff' && req.method === 'GET') return handleGitDiff(req);
          if (url.pathname === '/api/models' && req.method === 'GET') return handleGetModels(req);
          if (url.pathname === '/api/usage/export' && req.method === 'GET') return handleUsageExport(req);
          if (url.pathname === '/api/integrations/vercel' && (req.method === 'GET' || req.method === 'POST')) return handleVercelIntegration(req);
          if (url.pathname === '/api/integrations/google-docs' && (req.method === 'GET' || req.method === 'POST')) return handleGoogleDocsIntegration(req);
          if (url.pathname === '/api/google-docs/document' && req.method === 'GET') return handleGoogleDocsDocument();
          if (url.pathname === '/api/google-docs/append' && req.method === 'POST') return handleGoogleDocsAppend(req, false);
          if (url.pathname === '/api/google-docs/append-if-absent' && req.method === 'POST') return handleGoogleDocsAppend(req, true);
          if (url.pathname === '/api/google-docs/replace' && req.method === 'POST') return handleGoogleDocsReplace(req);
          if (url.pathname === '/api/harness/instructions' && req.method === 'GET') return handleHarnessInstructions();
          if (url.pathname === '/api/health' && req.method === 'GET') return handleRuntimeHealth();
          if (url.pathname === '/api/project-file' && req.method === 'GET') return handleProjectFile(req);
          if (url.pathname === '/api/chat/image-upload' && req.method === 'POST') return handleChatImageUpload(req);
          if (url.pathname === '/api/chat/image' && req.method === 'GET') return handleChatImage(req);
          if (url.pathname === '/api/simulators' && req.method === 'GET') return handleListSimulators(req);
          if (url.pathname === '/api/simulators/boot' && req.method === 'POST') return handleBootSimulator(req);
          if (url.pathname === '/api/simulators/shutdown' && req.method === 'POST') return handleShutdownSimulator(req);
          if (url.pathname === '/api/simulators/erase' && req.method === 'POST') return handleEraseSimulator(req);
          if (url.pathname === '/api/simulators/clean-derived-data' && req.method === 'POST') return handleCleanDerivedData(req);
          if (url.pathname === '/api/browser/navigate' && req.method === 'POST') return handleBrowserNavigate(req);
          if (url.pathname === '/api/browser/screenshot' && req.method === 'POST') return handleBrowserScreenshot(req);
          if (url.pathname === '/api/browser/click' && req.method === 'POST') return handleBrowserClick(req);
          if (url.pathname === '/api/browser/type' && req.method === 'POST') return handleBrowserType(req);
          if (url.pathname === '/api/browser/wait-for-ready' && req.method === 'POST') return handleBrowserWaitForReady(req);
          if (url.pathname === '/api/browser/console' && req.method === 'GET') return handleBrowserConsoleGet(req);
          if (url.pathname === '/api/browser/console/clear' && req.method === 'POST') return handleBrowserConsoleClear(req);
          if (url.pathname === '/api/browser/status' && req.method === 'GET') return handleBrowserStatus(req);
          if (url.pathname === '/api/browser/evaluate' && req.method === 'POST') return handleBrowserEvaluate(req);
          if (url.pathname === '/api/browser/network' && req.method === 'GET') return handleBrowserNetworkGet(req);
          if (url.pathname === '/api/browser/network/clear' && req.method === 'POST') return handleBrowserNetworkClear(req);
          if (url.pathname === '/api/browser/viewport' && req.method === 'POST') return handleBrowserViewport(req);
          if (url.pathname === '/api/browser/context/close' && req.method === 'POST') return handleBrowserContextClose(req);
          if (url.pathname === '/api/qa/screenshot' && req.method === 'GET') return handleQaScreenshot(req);
          if (url.pathname === '/api/atlas/file' && req.method === 'GET') return handleAtlasFile(req);
          if (url.pathname === '/api/atlas/ask' && req.method === 'POST') return handleAskAtlas(req);

          return new Response('Not Found', { status: 404 });
        },
        websocket: websocketHandlers,
        // Bun 1.3.14's injected HMR observer throws when a browser extension
        // briefly inserts a stylesheet link without a valid href. Agent Forge
        // is a restart-driven local harness, so serve the stable bundled page
        // without the dev overlay/HMR client.
        development: false,
        // Bun enables SO_REUSEPORT by default when development is false, which
        // lets a second instance bind this port and split traffic with us.
        // Keep the bind exclusive so the port fallback above kicks in.
        reusePort: false,
        error(err) {
          console.error('Server error:', err);
          return new Response('Internal error', { status: 500 });
        },
      });
    } catch (e) {
      lastErr = e;
      console.warn(`Port ${port} unavailable, trying ${port + 1}...`);
    }
  }
  console.error(`Failed to bind any port in ${preferredPort}-${preferredPort + maxAttempts - 1}:`, lastErr);
  throw lastErr;
}

const preferredPort = parseServerPort(process.env.PORT);
await logOccupiedPreferredPorts(preferredPort);

const server = startServer(preferredPort);
if (server.port !== preferredPort) {
  console.warn(`NOTE: Preferred port ${preferredPort} was busy; bound to ${server.port} instead.`);
}

// Tell QA + Atlas services the bound port — they substitute {GUI_PORT} into their system prompts
// at provision time so the spawned agents call back to the same Bun.serve we just bound.
qaService.setGuiPort(server.port ?? 0);
atlasService.setGuiPort(server.port ?? 0);
googleDocsService.setGuiPort(server.port ?? 0);
// Provider limits: initial read now, then every minute.
limitsService.start();
console.log(`Server running at http://localhost:${server.port}`);

// --- Graceful and fatal shutdown ---
// All stages are exactly-once and bounded. PIDs are not blindly cleared:
// each subsystem removes only confirmed exits, leaving any unconfirmed child
// durable for next-start orphan recovery.
export const shutdown = createShutdownCoordinator({
  stopIntake() {
    limitsService.stop();
    usageService.stopSync();
    server.stop(true);
  },
  async stopWork() {
    const results = await Promise.allSettled([
      agentService.shutdownAll(),
      terminalService.killAll(),
      browserService.close(),
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), 'One or more cleanup operations failed');
  },
  async forceStopWork() {
    await Promise.allSettled([
      agentService.killAllProcesses(),
      terminalService.killAll(),
      browserService.close(),
    ]);
  },
  persistData: () => persistenceService.saveNow(),
  persistPids: () => persistenceService.savePidsNow(),
  releaseLock: releaseProcessLock,
  exit: code => process.exit(code),
});

// Watch the actual launcher identity as well as signals. Also allow the
// desktop restart script to request the normal persistence/cleanup path.
if (process.platform === 'win32') {
  const launcherPid = Number(process.env.AGENT_FORGE_LAUNCHER_PID ?? process.ppid);
  if (Number.isSafeInteger(launcherPid) && launcherPid > 0) {
    monitorLauncher({
      probe: () => processProbe.probe(launcherPid),
      stopRequested: () => !!processLockHandle && existsSync(`${LOCK_FILE}.stop-${processLockHandle.owner.token}`),
      shutdown: reason => { void shutdown({ reason }); },
    });
  }
}

process.on('unhandledRejection', reason => {
  console.error('Unhandled rejection; initiating fatal shutdown:', reason);
  void shutdown({ exitCode: 1, reason: 'unhandled promise rejection', force: true });
});
process.on('uncaughtException', (error, origin) => {
  console.error(`Uncaught exception (${origin}); initiating fatal shutdown:`, error);
  void shutdown({ exitCode: 1, reason: `uncaught exception (${origin})`, force: true });
});
process.on('SIGINT', () => { void shutdown({ reason: 'SIGINT' }); });
process.on('SIGTERM', () => { void shutdown({ reason: 'SIGTERM' }); });
// SIGHUP fires on terminal close on Windows when the parent shell exits.
// Same flush-then-die path so data isn't lost if you close the PowerShell
// window instead of Ctrl+C-ing.
process.on('SIGHUP', () => { void shutdown({ reason: 'SIGHUP' }); });
