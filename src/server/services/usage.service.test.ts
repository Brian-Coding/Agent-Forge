import { test, expect } from 'bun:test';
import { selectEventsForMachineShard, usageService } from './usage.service';
import type { UsageEvent } from '../../shared/protocol';

// Report-compute regression net for the 2026-07-09 Token Usage redesign.
// Feeds a synthetic event log through load() and checks the derived windows,
// breakdowns, daily rows, and headline stats.

const DAY = 24 * 60 * 60 * 1000;

function ev(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    timestamp: Date.now(),
    agentId: 'agent-1',
    provider: 'claude',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    turns: 1,
    ...overrides,
  };
}

test('usage report aggregates windows, models, and daily rows correctly', () => {
  const now = Date.now();
  usageService.load([
    // Today: one Claude turn on Fable, one Codex turn on 5.6-sol
    ev({ timestamp: now - 60_000, provider: 'claude', model: 'claude-fable-5', agentName: 'Main', workspaceId: 'forge', workspaceName: 'Agent Forge', inputTokens: 1000, outputTokens: 500 }),
    ev({ timestamp: now - 30_000, provider: 'codex', model: 'gpt-5.6-sol', agentName: 'Main', agentId: 'agent-1', workspaceId: 'forge', workspaceName: 'Agent Forge', inputTokens: 2000, outputTokens: 1000 }),
    // 3 days ago: inside days7/days30/allTime but not today
    ev({ timestamp: now - 3 * DAY, provider: 'claude', model: 'claude-opus-4-8', agentId: 'agent-2', agentName: 'Second', workspaceId: 'other', workspaceName: 'Other Project', inputTokens: 4000, outputTokens: 4000 }),
    // 40 days ago: allTime only — also a legacy event with no model stamp
    ev({ timestamp: now - 40 * DAY, provider: 'codex', agentId: 'agent-3', inputTokens: 100, outputTokens: 50 }),
  ]);

  const report = usageService.getReportForConnect();

  // Window membership
  expect(report.windows.today.summary.total.turns).toBe(2);
  expect(report.windows.days7.summary.total.turns).toBe(3);
  expect(report.windows.allTime.summary.total.turns).toBe(4);
  expect(report.windows.today.summary.claude.inputTokens).toBe(1000);
  expect(report.windows.today.summary.codex.outputTokens).toBe(1000);

  // Model breakdown: unrecorded legacy events fold into "(unrecorded)"
  const allModels = report.windows.allTime.byModel.map(r => r.key);
  expect(allModels).toContain('claude-fable-5');
  expect(allModels).toContain('gpt-5.6-sol');
  expect(allModels).toContain('(unrecorded)');

  // byAgent sorted by total tokens desc — agent-2 (8000) leads all-time
  expect(report.windows.allTime.byAgent[0]!.key).toBe('agent-2');
  expect(report.windows.allTime.byAgent[0]!.label).toBe('Second');

  // Headline stats
  expect(report.windows.today.stats.totalTokens).toBe(4500);
  expect(report.windows.today.stats.avgInputPerTurn).toBe(1500);
  expect(report.windows.today.stats.biggestTurn?.tokens).toBe(3000);
  expect(report.windows.today.stats.biggestTurn?.model).toBe('gpt-5.6-sol');
  expect(report.windows.allTime.stats.outputInputRatio).toBeCloseTo(5550 / 7100, 2);

  // Daily: exactly 30 zero-filled rows, oldest first, today's row populated
  expect(report.daily.length).toBe(30);
  const todayRow = report.daily[report.daily.length - 1]!;
  expect(todayRow.total.inputTokens).toBe(3000);
  expect(todayRow.total.outputTokens).toBe(1500);

  // Project groups replace the old global recent-turn list. Turns nest newest first.
  const forge = report.windows.allTime.projects.find(project => project.workspaceId === 'forge')!;
  expect(forge.workspaceName).toBe('Agent Forge');
  expect(forge.eventCount).toBe(2);
  expect(forge.turns[0]!.provider).toBe('codex');
  expect(forge.turns[0]!.model).toBe('gpt-5.6-sol');

  expect(report.trackingStartedAt).toBe(now - 40 * DAY);
  expect(report.sync.enabled).toBe(false);

  usageService.load([]); // reset shared module state for other tests
});

test('usage load tolerates malformed and legacy events', () => {
  usageService.load([
    null as any,
    { timestamp: 'nope' } as any,
    ev({ timestamp: Date.now(), inputTokens: 10, outputTokens: 5 }), // valid, no model/agentName
  ]);
  const report = usageService.getReportForConnect();
  expect(report.windows.allTime.summary.total.turns).toBe(1);
  expect(report.windows.allTime.byModel[0]!.key).toBe('(unrecorded)');
  usageService.load([]);
});

test('usage report separates the current machine and summarizes remote machines', () => {
  usageService.load([]);
  const currentMachineId = usageService.getReportForConnect().sync.machineId;
  const now = Date.now();

  usageService.load([
    ev({ machineId: currentMachineId, timestamp: now - 30_000, inputTokens: 100, outputTokens: 50 }),
    // Pre-shard history belongs to the machine rendering the report.
    ev({ machineId: 'legacy', timestamp: now - 20_000, inputTokens: 20, outputTokens: 5 }),
    ev({ machineId: 'machine-b', timestamp: now - 10_000, provider: 'codex', inputTokens: 1000, outputTokens: 500 }),
  ]);

  const report = usageService.getReportForConnect();
  expect(report.windows.today.stats.totalTokens).toBe(1675);
  expect(report.currentMachine.windows.today.stats.totalTokens).toBe(175);
  expect(report.currentMachine.windows.today.summary.total.turns).toBe(2);

  const current = report.machines.find(machine => machine.machineId === currentMachineId)!;
  const remote = report.machines.find(machine => machine.machineId === 'machine-b')!;
  expect(current.isCurrent).toBe(true);
  expect(current.eventCount).toBe(2);
  expect(current.windows.today.total.inputTokens).toBe(120);
  expect(remote.isCurrent).toBe(false);
  expect(remote.eventCount).toBe(1);
  expect(remote.windows.today.total.outputTokens).toBe(500);
  expect(report.machines[0]!.machineId).toBe(currentMachineId);

  usageService.load([]);
});

test('a new runtime shard is seeded only with events belonging to the current machine', () => {
  const duplicate = ev({ machineId: 'local-pc', inputTokens: 10 });
  const seeded = selectEventsForMachineShard([
    duplicate,
    duplicate,
    ev({ machineId: 'legacy', inputTokens: 20 }),
    ev({ inputTokens: 30 }),
    ev({ machineId: 'remote-pc', inputTokens: 40 }),
  ], 'local-pc');

  expect(seeded.map(event => event.inputTokens)).toEqual([10, 20, 30]);
});

test('usage exports honor current-machine scope', () => {
  usageService.load([]);
  const currentMachineId = usageService.getReportForConnect().sync.machineId;
  usageService.load([
    ev({ machineId: currentMachineId, inputTokens: 10 }),
    ev({ machineId: 'legacy', inputTokens: 20 }),
    ev({ machineId: 'remote-pc', inputTokens: 30 }),
  ]);

  expect(usageService.buildExportRows('current').map(row => row.inputTokens)).toEqual([10, 20]);
  expect(usageService.buildExportRows('all').map(row => row.inputTokens)).toEqual([10, 20, 30]);
  expect(usageService.buildExportRows('current').every(row => row.machineId === currentMachineId)).toBe(true);
  usageService.load([]);
});
