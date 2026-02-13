import React from 'react';
import type { AgentInfo } from '../types';

interface Props {
  agents: AgentInfo[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onNewAgent: () => void;
}

const statusLabels: Record<string, string> = {
  idle: 'Idle',
  working: 'Working...',
  error: 'Error',
  stopped: 'Stopped',
};

export function AgentList({ agents, selectedIds, onToggle, onNewAgent }: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Terminal</span>
      </div>

      <div className="agents-header">Agents</div>

      <div className="agent-list">
        {agents.length === 0 && (
          <div style={{ padding: '12px', color: 'var(--text-muted)', fontSize: '12px' }}>
            No agents yet. Click "+ Agent" to create one.
          </div>
        )}
        {agents.map((agent) => (
          <div
            key={agent.id}
            className={`agent-item ${selectedIds.includes(agent.id) ? 'selected' : ''}`}
            onClick={() => onToggle(agent.id)}
          >
            <span className="agent-icon">⌘</span>
            <div className="agent-info">
              <div className="agent-name">{agent.name}</div>
              <div className="agent-status-text">
                <span className={`status-dot status-${agent.status}`} style={{ display: 'inline-block', marginRight: '4px', verticalAlign: 'middle' }} />
                {statusLabels[agent.status] || agent.status}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
