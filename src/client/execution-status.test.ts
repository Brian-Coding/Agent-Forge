import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { AgentInfo, LiveTurnStateSnapshot } from '../shared/protocol';

const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const start = source.indexOf('    function executionPresentation(');
const end = source.indexOf('    function useExecutionPresentation(', start);
const presentation = new Function('agentPresentationStatus', `${source.slice(start, end)}; return executionPresentation;`)(
  (agent: Partial<AgentInfo>) => agent.status === 'idle'
    ? (agent.lastTurnOutcome?.status === 'failed' ? 'error' : agent.lastTurnOutcome?.status || 'idle')
    : agent.status,
) as (agent: Partial<AgentInfo>, live: Partial<LiveTurnStateSnapshot> | null, connected: boolean, now: number) => {
  status: string; label: string; active: boolean;
};

test('process lifetime never claims continuous thinking and silence is uncertainty, not completion', () => {
  const agent = { status: 'thinking' as const };
  const live = { active: true, phase: 'thinking' as const, startedAt: 1, lastProviderEventAt: 100 };
  expect(presentation(agent, live, true, 500).status).toBe('working');
  const silent = presentation(agent, live, true, 5_000_000);
  expect(silent).toMatchObject({ status: 'uncertain', active: false });
  expect(silent.label).not.toContain('Thinking');
  expect(silent.label).not.toContain('completed');
  expect(source).toContain("' · run elapsed '");
  // A long tool with fresh events remains active regardless of total age.
  expect(presentation(agent, { ...live, phase: 'tool', lastProviderEventAt: 5_000_000 }, true, 5_000_100))
    .toMatchObject({ status: 'working', label: 'Running tool', active: true });
});

test('completed, interrupted, failed and continuing provider turns remain distinct while process is open', () => {
  for (const [provider, status] of [['completed', 'waiting'], ['stopped', 'stopped'], ['failed', 'error'], ['running', 'working']] as const) {
    const result = presentation({ status: 'thinking' }, {
      active: true, lastProviderEventAt: 100,
      providerTurn: { status: provider, source: 'rollout', id: 'turn', at: 100 },
    }, true, 150);
    expect(result.status).toBe(status);
    if (provider !== 'running') {
      expect(result.active).toBe(false);
      expect(result.label).toContain('run still open');
    }
  }
});

test('disconnect and reconnect hydration cannot reuse a stale running snapshot', () => {
  const running = { status: 'thinking' as const };
  expect(presentation(running, { active: true, lastProviderEventAt: 100 }, false, 110))
    .toMatchObject({ status: 'uncertain', active: false });
  expect(presentation(running, null, true, 110)).toMatchObject({ status: 'uncertain', active: false });
  expect(presentation(running, { active: false }, true, 110).status).toBe('uncertain');
  expect(presentation({ status: 'idle', lastTurnOutcome: { status: 'completed', at: 100 } }, { active: false }, true, 110).status).toBe('completed');
  expect(presentation({ status: 'idle', lastTurnOutcome: { status: 'failed', at: 100 } }, null, true, 110).status).toBe('error');
  expect(presentation({ status: 'idle', lastTurnOutcome: { status: 'stopped', at: 100 } }, null, true, 110).status).toBe('stopped');
  expect(source).toMatch(/ws.onopen = \(\) => \{[\s\S]*?liveTurnStateRef.current = \{\};[\s\S]*?setLiveTurnState\(\{\}\);/);
});

test('provider reconnect is waiting and recovery resumes running without implying completion', () => {
  const agent = { status: 'thinking' as const };
  const live = { active: true, phase: 'transport' as const, lastProviderEventAt: 100 };
  expect(presentation(agent, live, true, 150)).toMatchObject({ status: 'waiting', active: false });
  expect(presentation(agent, { ...live, phase: 'working' }, true, 150)).toMatchObject({ status: 'working', active: true });
});

test('a provider interruption is not attributed to the user or to an inactivity timeout', () => {
  const start = source.indexOf('    const RECONNECT_PROGRESS_RE');
  const end = source.indexOf('    function formatMessageTime', start);
  const parse = new Function(`${source.slice(start, end)}; return parseSystemTurnOutcome;`)();
  expect(parse('[Stopped: provider interrupted the turn]')).toMatchObject({
    kind: 'stopped', title: 'Turn interrupted by the provider',
  });
});
