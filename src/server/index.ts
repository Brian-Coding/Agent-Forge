import type { PersistedData } from '../shared/protocol';
import index from '../client/index.html';

import { persistenceService } from './services/persistence.service';
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

import { websocketHandlers } from './ws';

import { handleDirectories } from './routes/directories.routes';
import { handleGetPorts, handleKillPort } from './routes/ports.routes';
import { handleGitBranch } from './routes/git.routes';
import { handleGetModels } from './routes/models.routes';
import { handleUsageExport } from './routes/usage.routes';
import { handleVercelIntegration } from './routes/integrations.routes';
import { handleHarnessInstructions } from './routes/harness.routes';
import { handleAskAtlas } from './routes/atlas.routes';
import { handleProjectFile } from './routes/project-file.routes';
import { handleChatImage, handleChatImageUpload } from './routes/chat-image.routes';
import { handleListSimulators, handleBootSimulator, handleShutdownSimulator, handleEraseSimulator, handleCleanDerivedData } from './routes/simulator.routes';
import { handleBrowserNavigate, handleBrowserScreenshot, handleBrowserClick, handleBrowserType, handleBrowserWaitForReady, handleBrowserConsoleGet, handleBrowserConsoleClear, handleBrowserStatus, handleBrowserEvaluate, handleBrowserNetworkGet, handleBrowserNetworkClear, handleBrowserViewport, handleBrowserContextClose, handleQaScreenshot, handleAtlasFile } from './routes/browser.routes';

// Catch unhandled promise rejections to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Catch synchronous uncaught exceptions. Without this, anything thrown
// outside an async context (a stray sync error in a hot path) takes the
// whole server down and orphans port 3333 on Windows. Log and continue;
// graceful shutdown is wired to SIGINT/SIGTERM/SIGHUP below.
process.on('uncaughtException', (err, origin) => {
  console.error(`Uncaught exception (${origin}):`, err);
});

// --- Process lock --------------------------------------------------------
// Prevents two agent-forge bun.exe instances from clobbering the same
// data.json. The lock is cwd-relative so two checkouts in different dirs
// don't fight. At startup we read it; if it points at a live bun.exe that
// is NOT one of our ancestors, we kill it before doing anything else. If
// it IS our ancestor (an agent inside a running server tried to spawn its
// own `bun run dev`), we refuse to start so we don't terminate our own
// parent.

const LOCK_FILE = './agent-forge.lock';

/**
 * One tasklist call returning a Map<pid, processName>. Replaces the per-PID
 * PowerShell `Get-Process` lookups that used to fire 1-30+ times during
 * startup — each PowerShell cold-start was ~1-2s and they sometimes hung as
 * zombies, producing the visible PowerShell pile that pegged CPU.
 *
 * tasklist is a native Win32 binary (~10ms cold start) and emits CSV.
 */
async function getProcessNameMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (process.platform !== 'win32') return map;
  try {
    const proc = Bun.spawn(['tasklist', '/FO', 'CSV', '/NH'], { stdout: 'pipe', stderr: 'pipe' });
    await proc.exited;
    const out = await new Response(proc.stdout).text();
    for (const line of out.split('\n')) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (!m) continue;
      const name = m[1]!.replace(/\.exe$/i, '').toLowerCase();
      const pid = parseInt(m[2]!, 10);
      if (!isNaN(pid)) map.set(pid, name);
    }
  } catch {}
  return map;
}

/**
 * Are we standing inside a process chain that already includes the given
 * PID? Used so a `bun run dev` started by an agent INSIDE agent-forge can't
 * accidentally terminate the parent server when its lock-acquire sees the
 * parent's PID.
 *
 * Old version walked the ancestor chain via repeated `Get-CimInstance
 * Win32_Process` PowerShell calls — up to 32 spawns per check, each one
 * a slow WMI query that visibly hammered WMI Provider Host. New version
 * uses Bun's `process.ppid` for the immediate parent (the only case that
 * actually matters in practice — Claude / Codex inside the running server
 * spawning their own bun) and no shell-outs at all.
 *
 * If you somehow need to detect a deeper ancestor (grandparent or beyond),
 * note that only the immediate parent is checked; deeper ancestors are
 * not verified. This trade-off avoids the WMI process flood.
 */
function isPidImmediateAncestor(targetPid: number): boolean {
  if (process.platform !== 'win32') return false;
  if (targetPid === process.pid) return true;
  if (typeof process.ppid === 'number' && targetPid === process.ppid) return true;
  return false;
}

async function acquireProcessLock(): Promise<void> {
  const { readFileSync, writeFileSync, existsSync } = await import('fs');
  let priorPid: number | null = null;
  try {
    if (existsSync(LOCK_FILE)) {
      const raw = readFileSync(LOCK_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.pid === 'number' && parsed.pid !== process.pid) {
        priorPid = parsed.pid;
      }
    }
  } catch {
    // Malformed lock file — overwrite below.
  }

  if (priorPid !== null && process.platform === 'win32') {
    // Single tasklist call covers both the "is it alive?" and "is it bun?"
    // questions in one ~10ms shell-out instead of a 1-2s PowerShell spawn.
    const nameMap = await getProcessNameMap();
    const priorName = nameMap.get(priorPid);
    const isAliveBun = priorName === 'bun';

    if (isAliveBun) {
      if (isPidImmediateAncestor(priorPid)) {
        console.error(
          `\nRefusing to start: agent-forge.lock is owned by our ancestor process (PID ${priorPid}).\n` +
          `This usually means an agent (Claude/Codex) inside a running agent-forge tried to spawn its own \`bun run dev\`.\n` +
          `Exiting so the parent server stays alive.\n`,
        );
        process.exit(1);
      }
      console.log(`Another agent-forge bun.exe is running (PID ${priorPid}); killing it to free data.json + ports.`);
      try {
        const proc = Bun.spawn(['taskkill', '/F', '/T', '/PID', String(priorPid)], { stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
        // Brief pause so Windows finishes releasing file handles + sockets.
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.warn(`Failed to kill prior bun.exe ${priorPid}:`, e);
      }
    } else if (priorName) {
      console.log(`Stale agent-forge.lock (PID ${priorPid} now running as '${priorName}', not bun); overwriting.`);
    } else {
      console.log(`Stale agent-forge.lock (PID ${priorPid} no longer running); overwriting.`);
    }
  }

  try {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    console.warn('Could not write agent-forge.lock:', e);
  }
}

async function releaseProcessLock(): Promise<void> {
  try {
    const { readFileSync, unlinkSync, existsSync } = await import('fs');
    if (existsSync(LOCK_FILE)) {
      const parsed = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
      if (parsed.pid === process.pid) unlinkSync(LOCK_FILE);
    }
  } catch {
    // Best-effort cleanup; never block shutdown for this.
  }
}

// --- Orphan-port cleanup -------------------------------------------------
// Previous server runs sometimes don't release their port (Bun killed mid-
// stream, parent shell closed, uncaught exception that left a zombie).
// Before binding, scan for bun.exe processes LISTENING on our port range
// and taskkill them. Conservative: only kills `bun.exe`, never our own
// PID, and never any ancestor. Range is preferredPort..preferredPort+7 so
// a second agent-forge instance running on a different port (e.g. 4000
// when we're on 3333) is outside the range and stays untouched.

async function killOrphanBunOnPortRange(preferredPort: number): Promise<void> {
  if (process.platform !== 'win32') return;
  const ourPid = process.pid;
  const rangeStart = preferredPort;
  const rangeEnd = preferredPort + 7;

  // Two shell-outs total: netstat (port→pid map) + tasklist (pid→name map).
  // Old version did netstat + N PowerShells (one per candidate PID) which
  // could each take 1-2s to cold-start and sometimes zombie'd, contributing
  // to the visible PowerShell pile.
  let netstatOut = '';
  let nameMap = new Map<number, string>();
  try {
    [netstatOut, nameMap] = await Promise.all([
      (async () => {
        const proc = Bun.spawn(['netstat', '-ano'], { stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
        return new Response(proc.stdout).text();
      })(),
      getProcessNameMap(),
    ]);
  } catch (e) {
    console.warn('Orphan-port scan: process inspection failed, skipping cleanup:', e);
    return;
  }

  const orphanPids = new Set<number>();
  for (const line of netstatOut.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
    const m = parts[1]!.match(/:(\d+)$/);
    if (!m) continue;
    const port = parseInt(m[1]!, 10);
    if (port < rangeStart || port > rangeEnd) continue;
    const pid = parseInt(parts[4]!, 10);
    if (!Number.isFinite(pid) || pid === 0 || pid === ourPid) continue;
    orphanPids.add(pid);
  }

  if (orphanPids.size === 0) return;

  // Filter to actual bun.exe processes (don't kill the user's Vite, Chrome QUIC, etc.)
  // and skip immediate ancestors (the parent that spawned us).
  const safeToKill: number[] = [];
  for (const pid of orphanPids) {
    const name = nameMap.get(pid);
    if (name !== 'bun') {
      if (name) console.log(`Orphan-port scan: PID ${pid} is ${name}, leaving alone.`);
      continue;
    }
    if (isPidImmediateAncestor(pid)) {
      console.log(`Orphan-port scan: PID ${pid} is our parent — skipping.`);
      continue;
    }
    safeToKill.push(pid);
  }
  if (safeToKill.length === 0) return;

  console.log(`Orphan-port scan: killing ${safeToKill.length} stale bun.exe process(es) on ports ${rangeStart}-${rangeEnd}:`, safeToKill);
  await Promise.all(
    safeToKill.map(async pid => {
      try {
        const proc = Bun.spawn(['taskkill', '/F', '/T', '/PID', String(pid)], { stdout: 'pipe', stderr: 'pipe' });
        await proc.exited;
      } catch (e) {
        console.warn(`Orphan-port scan: taskkill PID ${pid} failed:`, e);
      }
    }),
  );
  // Brief pause so Windows releases the socket before we try to bind.
  await new Promise(r => setTimeout(r, 300));
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
    await workspaceService.loadAndMigrate(
      data.workspaces,
      data.settings,
      data.agents.map(a => a.id),
      agentService.setAgentWorkspace,
    );
    usageService.load(data.usageEvents);
    console.log(`Loaded ${data.agents.length} agents, ${data.messages.length} messages, ${documentService.getAll().length} documents, ${workspaceService.getAll().length} workspaces, ${(data.usageEvents ?? []).length} usage entries from disk`);
  }

  // Wire up cross-service callbacks
  initAgentService();

  // Register the buildPersistedData collector
  persistenceService.setBuildPersistedData((): PersistedData => ({
    agents: agentService.buildPersistedAgents() as any,
    messages: agentService.buildPersistedMessages(),
    sharedContext: agentService.getSharedContext(),
    documents: documentService.getAll(),
    settings: settingsService.get(),
    workspaces: workspaceService.getAll(),
    usageEvents: usageService.getEvents(),
  }));

  usageService.startSync();
}

// Lock FIRST — kill any prior bun.exe — THEN load data.json. If we load
// first, a still-running prior instance could mutate data.json between
// our read and our kill, and we'd save our older state on top of it.
await acquireProcessLock();

await init();

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
          if (url.pathname === '/api/models' && req.method === 'GET') return handleGetModels(req);
          if (url.pathname === '/api/usage/export' && req.method === 'GET') return handleUsageExport(req);
          if (url.pathname === '/api/integrations/vercel' && (req.method === 'GET' || req.method === 'POST')) return handleVercelIntegration(req);
          if (url.pathname === '/api/harness/instructions' && req.method === 'GET') return handleHarnessInstructions();
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
        development: {
          hmr: true,
          console: true,
        },
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

const preferredPort = parseInt(process.env.PORT || '3333');
await killOrphanBunOnPortRange(preferredPort);

const server = startServer(preferredPort);
if (server.port !== preferredPort) {
  console.warn(`NOTE: Preferred port ${preferredPort} was busy; bound to ${server.port} instead.`);
}

// Tell QA + Atlas services the bound port — they substitute {GUI_PORT} into their system prompts
// at provision time so the spawned agents call back to the same Bun.serve we just bound.
qaService.setGuiPort(server.port ?? 0);
atlasService.setGuiPort(server.port ?? 0);
// Provider limits: initial read now, then every minute.
limitsService.start();
console.log(`Server running at http://localhost:${server.port}`);

// --- Graceful shutdown ---
// CRITICAL: persistenceService.save() is debounced 200ms. If the user types
// a message and Ctrl+Cs within that window, process.exit kills the event
// loop before the timer fires and the message is dropped from data.json.
// The saveNow() race below flushes pending mutations BEFORE exit. Wrapped
// in its own timeout so a hung disk write can't block shutdown forever —
// losing pending data is bad, but a stuck shutdown that orphans the port
// is also bad.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; // Second Ctrl+C while already shutting down — ignore.
  shuttingDown = true;
  console.log('\nShutting down...');

  await Promise.race([
    (async () => {
      await agentService.shutdownAll();
      await terminalService.killAll();
      await browserService.close();
    })(),
    new Promise<void>(resolve => setTimeout(() => {
      console.warn('Shutdown timeout — force killing all processes...');
      agentService.killAllProcesses().catch(() => {});
      resolve();
    }, 5000)),
  ]);

  // Flush pending data.json writes BEFORE clearing PIDs / stopping the
  // server. 2s timeout so a stuck save can't prevent shutdown.
  await Promise.race([
    persistenceService.saveNow().catch(e => console.error('Final saveNow failed:', e)),
    new Promise<void>(resolve => setTimeout(() => {
      console.warn('Final data save timed out after 2s — proceeding to exit.');
      resolve();
    }, 2000)),
  ]);

  persistenceService.clearAllPids();
  await persistenceService.savePidsNow();
  await releaseProcessLock();
  server.stop(true);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// SIGHUP fires on terminal close on Windows when the parent shell exits.
// Same flush-then-die path so data isn't lost if you close the PowerShell
// window instead of Ctrl+C-ing.
process.on('SIGHUP', shutdown);
