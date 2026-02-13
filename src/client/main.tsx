import React from 'react';
import { createRoot } from 'react-dom/client';

console.log('main.tsx loaded');

const container = document.getElementById('root');
console.log('container:', container);

if (container) {
  try {
    const root = createRoot(container);
    console.log('root created');
    root.render(
      <div style={{ padding: 20, color: 'white', background: '#0d1117', minHeight: '100vh' }}>
        <h1>React is working!</h1>
        <p>Now let's load the full app...</p>
      </div>
    );
    console.log('render called');
  } catch (e) {
    console.error('React error:', e);
    container.innerHTML = '<h1 style="color:red">React error: ' + e + '</h1>';
  }
}
