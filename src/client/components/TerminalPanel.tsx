import React, { useState, useRef, useEffect } from 'react';
import type { AgentInfo, ChatMessage } from '../types';

interface Props {
  agent: AgentInfo | null;
  messages: ChatMessage[];
  liveOutput: string;
  onSendMessage: (content: string) => void;
  onKill: () => void;
}

export function TerminalPanel({ agent, messages, liveOutput, onSendMessage, onKill }: Props) {
  const [viewMode, setViewMode] = useState<'chat' | 'raw'>('chat');
  const [inputValue, setInputValue] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [messages, liveOutput]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim() && agent) {
      onSendMessage(inputValue.trim());
      setInputValue('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  if (!agent) {
    return (
      <div className="terminal-panel empty">
        <div className="empty-panel">
          <div className="empty-panel-icon">⌨</div>
          <span>No agent assigned</span>
        </div>
      </div>
    );
  }

  const isWorking = agent.status === 'working';

  return (
    <div className="terminal-panel">
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-title-icon">⌘</span>
          <span>Claude</span>
          <span className={`status-dot status-${agent.status}`} />
        </div>
        <div className="panel-tabs">
          <button
            className={`panel-tab ${viewMode === 'chat' ? 'active' : ''}`}
            onClick={() => setViewMode('chat')}
          >
            Chat
          </button>
          <button
            className={`panel-tab ${viewMode === 'raw' ? 'active' : ''}`}
            onClick={() => setViewMode('raw')}
          >
            Raw
          </button>
        </div>
      </div>

      <div className="panel-content" ref={contentRef}>
        {viewMode === 'chat' ? (
          <>
            {messages.length === 0 && !liveOutput && (
              <div style={{ color: 'var(--text-muted)' }}>
                Send a message to start...
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id} className={`message message-${msg.role}`}>
                <div className="message-content">{msg.content}</div>
              </div>
            ))}
            {liveOutput && (
              <div className="message message-assistant">
                <div className="message-content">
                  {liveOutput}
                  {isWorking && <span className="cursor" />}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="raw-output">
            {messages.map(m => `[${m.role}] ${m.content}`).join('\n\n')}
            {liveOutput && `\n\n[streaming...]\n${liveOutput}`}
          </div>
        )}
      </div>

      <div className="panel-input-container">
        <form onSubmit={handleSubmit}>
          <div className="panel-input-wrapper">
            <input
              type="text"
              className="panel-input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message... (Enter to send)"
              disabled={isWorking}
            />
            <div className="panel-input-actions">
              <button
                type="button"
                className="input-action-btn"
                title="More options"
              >
                ⋯
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
