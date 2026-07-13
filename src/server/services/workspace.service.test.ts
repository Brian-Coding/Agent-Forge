import { expect, test } from 'bun:test';
import type { WorkspaceInfo } from '../../shared/protocol';
import { sortWorkspaces } from './workspace.service';

function workspace(id: string, sortOrder: number, createdAt: number): WorkspaceInfo {
  return {
    id,
    name: id,
    sortOrder,
    createdAt,
    gridColumns: 2,
    gridRows: 2,
    selectedAgentIds: [],
    lockedAgentIds: [],
  };
}

test('workspace ordering follows persisted sortOrder with createdAt as a stable fallback', () => {
  const sorted = sortWorkspaces([
    workspace('third', 2, 1),
    workspace('second-newer', 1, 20),
    workspace('first', 0, 30),
    workspace('second-older', 1, 10),
  ]);
  expect(sorted.map(item => item.id)).toEqual(['first', 'second-older', 'second-newer', 'third']);
});
