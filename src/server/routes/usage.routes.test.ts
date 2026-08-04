import { afterEach, describe, expect, test } from 'bun:test';
import type { UsageEvent } from '../../shared/protocol';
import { usageService } from '../services/usage.service';
import { handleUsageExport } from './usage.routes';

function event(machineId: string, inputTokens: number): UsageEvent {
  return {
    timestamp: Date.now(),
    agentId: 'agent-1',
    provider: 'codex',
    machineId,
    inputTokens,
    outputTokens: 0,
    costUsd: 0,
    turns: 1,
  };
}

afterEach(() => usageService.load([]));

describe('usage export route', () => {
  test('exports only the current machine when requested', async () => {
    const currentMachineId = usageService.getReportForConnect().sync.machineId;
    usageService.load([
      event(currentMachineId, 10),
      event('remote-pc', 20),
    ]);

    const response = handleUsageExport(new Request('http://localhost/api/usage/export?format=json&scope=current'));
    const rows = await response.json();

    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(10);
    expect(response.headers.get('Content-Disposition')).toContain('agent-forge-usage-current-');
  });

  test('keeps all-machine export as the default for existing links', async () => {
    const currentMachineId = usageService.getReportForConnect().sync.machineId;
    usageService.load([
      event(currentMachineId, 10),
      event('remote-pc', 20),
    ]);

    const response = handleUsageExport(new Request('http://localhost/api/usage/export?format=csv'));
    const body = await response.text();

    expect(body.trim().split('\n')).toHaveLength(3);
    expect(response.headers.get('Content-Disposition')).toContain('agent-forge-usage-all-');
  });
});
