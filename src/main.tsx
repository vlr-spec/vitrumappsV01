import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import officialLogo from './assets/logo.ts';
import './index.css';
import './responsive.css';

const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/jpeg';
favicon.href = officialLogo;
document.head.appendChild(favicon);

// Disable mouse wheel changing number inputs globally
document.addEventListener(
  'wheel',
  (event) => {
    const activeElement = document.activeElement as HTMLInputElement | null;

    if (
      activeElement &&
      activeElement.tagName === 'INPUT' &&
      activeElement.type === 'number'
    ) {
      event.preventDefault();
    }
  },
  { passive: false }
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
