import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './index.css';
import { initTheme } from './theme.js';
import { installChunkRecovery } from './chunkRecovery.js';

// Re-applies the theme the inline script in index.html already chose, and
// releases the first-paint transition lock.
initTheme();
installChunkRecovery();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
