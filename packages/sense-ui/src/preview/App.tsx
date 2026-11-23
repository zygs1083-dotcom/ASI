import { useCallback, useEffect, useState } from 'react';
import { makeScenario, SCENARIOS, type ScenarioName } from '../mock/scenarios';
import { NeedsPanel } from '../NeedsPanel';
import type { NeedsPanelModel } from '../view-model';
import { tick } from './tick';

type Theme = 'light' | 'dark';

function readQuery(): { scenario: ScenarioName; theme: Theme; realtime: boolean } {
  const q = new URLSearchParams(location.search);
  const s = q.get('scenario');
  const t = q.get('theme');
  return {
    scenario: (SCENARIOS as readonly string[]).includes(s ?? '') ? (s as ScenarioName) : 'healthy',
    theme: t === 'dark' ? 'dark' : 'light',
    realtime: q.get('realtime') === '1',
  };
}

function applyTheme(theme: Theme) {
  if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
  else document.body.removeAttribute('data-ds-dark-theme');
  document.documentElement.style.colorScheme = theme;
}

export function App() {
  const [scenario, setScenario] = useState(readQuery().scenario);
  const [theme, setTheme] = useState(readQuery().theme);
  const [realtime, setRealtime] = useState(readQuery().realtime);
  const [model, setModel] = useState<NeedsPanelModel>(() => makeScenario(readQuery().scenario));
  const [lastAction, setLastAction] = useState('');

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    if (!realtime) return;
    const id = setInterval(() => setModel((m) => tick(m)), 1_000);
    return () => clearInterval(id);
  }, [realtime]);

  const switchScenario = (name: ScenarioName) => {
    setScenario(name);
    setModel(makeScenario(name));
  };

  const act = useCallback((text: string) => setLastAction(text), []);

  return (
    <>
      <nav className="demoBar" aria-label="预览工具栏">
        <label>
          场景
          <select value={scenario} onChange={(e) => switchScenario(e.target.value as ScenarioName)}>
            {SCENARIOS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          主题
          <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={realtime} onChange={(e) => setRealtime(e.target.checked)} />
          实时模式
        </label>
        <span className="demoAction">{lastAction}</span>
      </nav>
      <main className="stage">
        <NeedsPanel
          model={model}
          onPause={(p) => {
            setModel((m) => ({ ...m, paused: p }));
            act(p ? '已暂停感知与自维护' : '已恢复感知与自维护');
          }}
          onToggleTitles={(on) => {
            setModel((m) => ({ ...m, sendTitles: on }));
            act(on ? '窗口标题发给模型' : '窗口标题已隐藏');
          }}
          onOpenPermissionSettings={() => act('请求打开系统授权设置')}
          onApproveHelp={(id) => {
            setModel((m) => ({
              ...m,
              helpCards: m.helpCards.map((c) => (c.id === id ? { ...c, status: 'approved', updatedAt: m.now } : c)),
            }));
            act(`已批准求助 ${id}`);
          }}
          onDismissHelp={(id) => {
            setModel((m) => ({
              ...m,
              helpCards: m.helpCards.map((c) => (c.id === id ? { ...c, status: 'dismissed', updatedAt: m.now } : c)),
            }));
            act(`已忽略求助 ${id}`);
          }}
          onOpenMaintenanceSession={() => act('打开后台自维护会话')}
          onTriggerCheck={() => act('触发立即自检')}
        />
      </main>
    </>
  );
}
