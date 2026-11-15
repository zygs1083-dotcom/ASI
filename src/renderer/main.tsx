import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { actions, getState } from './store';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';

async function bootstrap(): Promise<void> {
  if (!window.asi && import.meta.env.DEV) {
    const { installMockApi } = await import('./dev/mockApi');
    installMockApi();
  }
  if (import.meta.env.DEV) {
    // 验证脚本（artifacts/scripts）用 import('/store.ts') 会拿到另一份模块实例，改为直接暴露真实 actions
    (window as unknown as { __asiActions?: typeof actions }).__asiActions = actions;
    (window as unknown as { __asiState?: typeof getState }).__asiState = getState;
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
