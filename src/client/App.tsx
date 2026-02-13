import React, { useState, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { AgentList } from './components/AgentList';
import { TerminalPanel } from './components/TerminalPanel';
import { NewAgentModal } from './components/NewAgentModal';
import { TopBar } from './components/TopBar';

export function App() {
  const {
    connected,
    agents,
    messages,
    liveOutput,
    createAgent,
    sendMessage,
    killAgent,
    getHistory,
  } = useWebSocket();

  const [columns, setColumns] = useState(3);
  const [rows, setRows] = useState(2);
  const [showNewAgentModal, setShowNewAgentModal] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);

  // Sync selected agents with available agents
  useEffect(() => {
    // Remove any selected agents that no longer exist
    setSelectedAgents(prev => prev.filter(id => agents.some(a => a.id === id)));
  }, [agents]);

  // Fetch history for selected agents
  useEffect(() => {
    selectedAgents.forEach(id => getHistory(id));
  }, [selectedAgents, getHistory]);

  const totalPanels = columns * rows;

  // Get agents to display in grid (selected ones, or fill with available)
  const displayAgents = [...selectedAgents];
  agents.forEach(agent => {
    if (!displayAgents.includes(agent.id) && displayAgents.length < totalPanels) {
      displayAgents.push(agent.id);
    }
  });

  const toggleAgentInPanel = (agentId: string) => {
    setSelectedAgents(prev => {
      if (prev.includes(agentId)) {
        return prev.filter(id => id !== agentId);
      }
      if (prev.length < totalPanels) {
        return [...prev, agentId];
      }
      return prev;
    });
  };

  const gridStyle = {
    gridTemplateColumns: `repeat(${columns}, 1fr)`,
    gridTemplateRows: `repeat(${rows}, 1fr)`,
  };

  return (
    <div className="app">
      <AgentList
        agents={agents}
        selectedIds={selectedAgents}
        onToggle={toggleAgentInPanel}
        onNewAgent={() => setShowNewAgentModal(true)}
      />

      <div className="main-content">
        {!connected && (
          <div className="connection-status">
            Disconnected from server. Reconnecting...
          </div>
        )}

        <TopBar
          columns={columns}
          rows={rows}
          onColumnsChange={setColumns}
          onRowsChange={setRows}
          onNewAgent={() => setShowNewAgentModal(true)}
        />

        <div className="terminal-grid" style={gridStyle}>
          {Array.from({ length: totalPanels }).map((_, index) => {
            const agentId = displayAgents[index];
            const agent = agentId ? agents.find(a => a.id === agentId) : null;
            const agentMessages = agentId ? messages.get(agentId) || [] : [];
            const agentLiveOutput = agentId ? liveOutput.get(agentId) || '' : '';

            return (
              <TerminalPanel
                key={index}
                agent={agent}
                messages={agentMessages}
                liveOutput={agentLiveOutput}
                onSendMessage={(content) => agent && sendMessage(agent.id, content)}
                onKill={() => agent && killAgent(agent.id)}
              />
            );
          })}
        </div>
      </div>

      <NewAgentModal
        isOpen={showNewAgentModal}
        onClose={() => setShowNewAgentModal(false)}
        onCreate={createAgent}
      />
    </div>
  );
}
