import { useState, useEffect, useCallback, useRef } from 'react';
import type { ClientMessage, ServerMessage, AgentInfo, ChatMessage } from '../types';

interface WebSocketState {
  connected: boolean;
  agents: AgentInfo[];
  messages: Map<string, ChatMessage[]>;
  liveOutput: Map<string, string>;
}

export function useWebSocket() {
  const [state, setState] = useState<WebSocketState>({
    connected: false,
    agents: [],
    messages: new Map(),
    liveOutput: new Map(),
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setState(prev => ({ ...prev, connected: true }));
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setState(prev => ({ ...prev, connected: false }));
      // Attempt to reconnect after 2 seconds
      reconnectTimeoutRef.current = window.setTimeout(connect, 2000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
      try {
        const message: ServerMessage = JSON.parse(event.data);
        handleMessage(message);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };

    wsRef.current = ws;
  }, []);

  const handleMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case 'agents_list':
        setState(prev => ({ ...prev, agents: message.agents }));
        break;

      case 'agent_created':
        setState(prev => ({
          ...prev,
          agents: [...prev.agents, message.agent],
        }));
        break;

      case 'agent_updated':
        setState(prev => ({
          ...prev,
          agents: prev.agents.map(a =>
            a.id === message.agent.id ? message.agent : a
          ),
        }));
        break;

      case 'agent_removed':
        setState(prev => ({
          ...prev,
          agents: prev.agents.filter(a => a.id !== message.agentId),
        }));
        break;

      case 'message':
        setState(prev => {
          const newMessages = new Map(prev.messages);
          const agentMessages = newMessages.get(message.message.agentId) || [];
          newMessages.set(message.message.agentId, [...agentMessages, message.message]);
          return { ...prev, messages: newMessages };
        });
        break;

      case 'history':
        setState(prev => {
          const newMessages = new Map(prev.messages);
          newMessages.set(message.agentId, message.messages);
          return { ...prev, messages: newMessages };
        });
        break;

      case 'output':
        setState(prev => {
          const newOutput = new Map(prev.liveOutput);
          const current = newOutput.get(message.agentId) || '';
          // Keep only last 10000 chars to prevent memory issues
          const updated = (current + message.content).slice(-10000);
          newOutput.set(message.agentId, updated);
          return { ...prev, liveOutput: newOutput };
        });
        break;

      case 'error':
        console.error('Server error:', message.message);
        break;
    }
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  const send = useCallback((message: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    }
  }, []);

  const createAgent = useCallback((name: string, cwd: string) => {
    send({ type: 'create_agent', name, cwd });
  }, [send]);

  const sendMessage = useCallback((agentId: string, content: string) => {
    // Clear live output when sending new message
    setState(prev => {
      const newOutput = new Map(prev.liveOutput);
      newOutput.set(agentId, '');
      return { ...prev, liveOutput: newOutput };
    });
    send({ type: 'send_message', agentId, content });
  }, [send]);

  const killAgent = useCallback((agentId: string) => {
    send({ type: 'kill_agent', agentId });
  }, [send]);

  const getHistory = useCallback((agentId: string) => {
    send({ type: 'get_history', agentId });
  }, [send]);

  return {
    connected: state.connected,
    agents: state.agents,
    messages: state.messages,
    liveOutput: state.liveOutput,
    createAgent,
    sendMessage,
    killAgent,
    getHistory,
  };
}
