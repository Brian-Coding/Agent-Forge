import React from 'react';

interface Props {
  columns: number;
  rows: number;
  onColumnsChange: (cols: number) => void;
  onRowsChange: (rows: number) => void;
  onNewAgent: () => void;
}

export function TopBar({ columns, rows, onColumnsChange, onRowsChange, onNewAgent }: Props) {
  return (
    <div className="top-bar">
      <div className="top-bar-left">
        {/* Can add tabs or other controls here */}
      </div>

      <div className="top-bar-right">
        <div className="grid-controls">
          <span className="grid-label">Col</span>
          <div className="grid-buttons">
            {[1, 2, 3, 4].map(n => (
              <button
                key={n}
                className={`grid-btn ${columns === n ? 'active' : ''}`}
                onClick={() => onColumnsChange(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="grid-controls">
          <span className="grid-label">Row</span>
          <div className="grid-buttons">
            {[1, 2, 3].map(n => (
              <button
                key={n}
                className={`grid-btn ${rows === n ? 'active' : ''}`}
                onClick={() => onRowsChange(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <button className="btn btn-primary" onClick={onNewAgent}>
          + Agent
        </button>
      </div>
    </div>
  );
}
