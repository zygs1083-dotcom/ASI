import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';

async function bootstrap(): Promise<void> {
  if (!window.asi && import.meta.env.DEV) {
    const { installMockApi } = await import('./dev/mockApi');
    installMockApi();
  }
  const root = document.getElementById('root');
  if (!root) {
    throw new Error('missing #root element');
  }
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
