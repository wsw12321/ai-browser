import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { captureBrowserHandoff } from './lib/handoff';
import './styles.css';
// Remove the one-time code before mounting React or starting any request.
const startupHandoff = captureBrowserHandoff();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App startupHandoff={startupHandoff} />
  </React.StrictMode>,
);
