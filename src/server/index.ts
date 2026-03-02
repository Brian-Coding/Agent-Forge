import type { PersistedData } from '../shared/protocol';
import index from '../client/index.html';

import { persistenceService } from './services/persistence.service';
import { settingsService } from './services/settings.service';
import { noteService } from './services/note.service';
import { workspaceService } from './services/workspace.service';
import { documentService } from './services/document.service';
import { agentService, initAgentService } from './services/agent.service';
import { terminalService } from './services/terminal.service';

import { websocketHandlers } from './ws';

import { handleDirectories } from './routes/directories.routes';
import { handleGetPorts, handleKillPort } from './routes/ports.routes';
import { handleGitBranch } from './routes/git.routes';
import { handleListSimulators, handleBootSimulator, handleShutdownSimulator, handleEraseSimulator, handleCleanDerivedData } from './routes/simulator.routes';

// Catch unhandled promise rejections to prevent silent crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// --- Startup: load persisted data and wire up services ---
async function init() {
  const data = await persistenceService.load();

  if (data) {
    settingsService.load(data.settings);
    noteService.load(data.notes);
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
    console.log(`Loaded ${data.agents.length} agents, ${data.messages.length} messages, ${noteService.getAll().length} notes, ${documentService.getAll().length} documents, ${workspaceService.getAll().length} workspaces from disk`);
  }

  // Wire up cross-service callbacks
  initAgentService();

  // Register the buildPersistedData collector
  persistenceService.setBuildPersistedData((): PersistedData => ({
    agents: agentService.buildPersistedAgents() as any,
    messages: agentService.buildPersistedMessages(),
    sharedContext: agentService.getSharedContext(),
    notes: noteService.getAll(),
    documents: documentService.getAll(),
    settings: settingsService.get(),
    workspaces: workspaceService.getAll(),
  }));
}

await init();

// --- Server ---
const server = Bun.serve({
  port: parseInt(process.env.PORT || '3333'),

  routes: {
    '/': index,
  },

  fetch(req, server) {
    const url = new URL(req.url);

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
    if (url.pathname === '/api/simulators' && req.method === 'GET') return handleListSimulators(req);
    if (url.pathname === '/api/simulators/boot' && req.method === 'POST') return handleBootSimulator(req);
    if (url.pathname === '/api/simulators/shutdown' && req.method === 'POST') return handleShutdownSimulator(req);
    if (url.pathname === '/api/simulators/erase' && req.method === 'POST') return handleEraseSimulator(req);
    if (url.pathname === '/api/simulators/clean-derived-data' && req.method === 'POST') return handleCleanDerivedData(req);

    return new Response('Not Found', { status: 404 });
  },

  websocket: websocketHandlers,

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at http://localhost:${server.port}`);

// --- Graceful shutdown ---
async function shutdown() {
  console.log('\nShutting down...');
  await Promise.race([
    (async () => {
      await agentService.shutdownAll();
      await terminalService.killAll();
    })(),
    new Promise<void>(resolve => setTimeout(() => {
      console.warn('Shutdown timeout — force killing all processes...');
      agentService.killAllProcesses().catch(() => {});
      resolve();
    }, 5000)),
  ]);
  persistenceService.clearAllPids();
  await persistenceService.savePidsNow();
  server.stop(true);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
