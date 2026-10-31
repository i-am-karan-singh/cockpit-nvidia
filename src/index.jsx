import React from 'react';
import { createRoot } from 'react-dom/client';
import '@patternfly/patternfly/patternfly.css';
import './theme.js';
import './style.css';
import { App } from './app.jsx';

createRoot(document.getElementById('app')).render(<App />);
