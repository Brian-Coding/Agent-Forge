import { broadcast } from '../../src/server/broadcast';
import { registerAdapter } from '../../src/server/agents/registry';
import { terminalService } from '../../src/server/services/terminal.service';
import { limitsService } from '../../src/server/services/limits.service';
import { usageService } from '../../src/server/services/usage.service';
import { agentService } from '../../src/server/services/agent.service';
import type { AgentAdapter } from '../../src/server/agents/types';

// These overrides exist only in this disposable demo process, never in dev/start.
limitsService.start = () => {};
usageService.startSync = () => {};
for (const kind of ['claude', 'codex'] as const) {
  const adapter: AgentAdapter<null> = {
    kind, displayName: 'Scripted stand-in', createState: () => null,
    createHandle(_prompt, ctx) {
      let stopped = false;
      return {
        async run() {
          ctx.emitAgentEvent({ type: 'status', status: 'thinking' });
          ctx.emitAgentEvent({ type: 'thinking-delta', text: 'Following the fixed fictional demo plan. No model is running.', streaming: true });
          await Bun.sleep(1500);
          if (stopped) return;
          const terminal = await terminalService.create(ctx.paneId, ctx.cwd, 'node --test smoke.test.cjs');
          broadcast({ type: 'terminal_created', terminal });
          await Bun.sleep(kind === 'claude' ? 1800 : 1000);
          if (stopped) return;
          ctx.emitAgentEvent({ type: 'result', text: kind === 'codex'
            ? '### Search handoff\n\nThe prepared Acme Notes fixture supports partial matches, empty results and clearing the query.\n\n- Inspect `notes.cjs`\n- Open the preview on port **' + process.env.FORGE_DEMO_PREVIEW_PORT + '**\n- Review the terminal test output below\n\n**Scripted stand-in:** this is a fixed demonstration, not AI-generated work.'
            : '### Verification handoff\n\nStarted the real Node test runner against the fictional fixture. Inspect its exit status and output below.\n\n| Check | Fixture expectation |\n| --- | --- |\n| Partial title | Matching note |\n| Missing title | Empty list |\n| Clear query | All notes |\n\n**Human approval:** review the diff and checks before integrating. No model was called.' });
          return undefined;
        }, stop() { stopped = true; }, kill() { stopped = true; },
      };
    },
  };
  registerAdapter(adapter);
}
const server = await import('../../src/server/index');
const agent = agentService.getAgent('demo-0');
if (agent) await terminalService.create(agent.id, agent.cwd, 'node preview.cjs');
await Bun.stdin.text();
await server.shutdown({ reason: 'scripted demo complete' });
