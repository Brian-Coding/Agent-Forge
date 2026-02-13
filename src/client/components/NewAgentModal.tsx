import React, { useState } from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string, cwd: string) => void;
}

export function NewAgentModal({ isOpen, onClose, onCreate }: Props) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (name.trim() && cwd.trim()) {
      onCreate(name.trim(), cwd.trim());
      setName('');
      setCwd('');
      onClose();
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal">
        <h2 className="modal-title">Create New Agent</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="agent-name">
              Agent Name
            </label>
            <input
              id="agent-name"
              type="text"
              className="form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Frontend Work"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="agent-cwd">
              Working Directory
            </label>
            <input
              id="agent-cwd"
              type="text"
              className="form-input"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="e.g., /Users/me/projects/myapp"
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!name.trim() || !cwd.trim()}
            >
              Create Agent
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
