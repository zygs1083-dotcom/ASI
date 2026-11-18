import { useCallback, useEffect, useState } from 'react';
import { makeScenario, SCENARIOS, type ScenarioName } from '../mock/scenarios';
import { MOCK_MONTHLY_2026_10 } from '../mock/scenarios-history';
import { SensePanel } from '../SensePanel';
import type { SensePanelModel } from '../view-model';
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
  const [model, setModel] = useState<SensePanelModel>(() => makeScenario(readQuery().scenario));
  const [historyCleared, setHistoryCleared] = useState(false);
  const [lastAction, setLastAction] = useState('');

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    if (!realtime) return;
    const id = setInterval(() => setModel((m) => tick(m)), 1_000);
    return () => clearInterval(id);
  }, [realtime]);

  const switchScenario = (name: ScenarioName) => {
    setScenario(name);
    setHistoryCleared(false);
    setModel(makeScenario(name));
  };

  const onListMonths = useCallback(async () => {
    if (historyCleared || scenario === 'history-empty') return [];
    return ['2026-10', '2026-09'];
  }, [historyCleared, scenario]);

  const onLoadMonthly = useCallback(
    async (month: string) => {
      if (scenario === 'history-monthly-error') {
        throw new Error('月度汇总读取失败（模拟错误）');
      }
      if (month === '2026-10') {
        return { available: true as const, summary: MOCK_MONTHLY_2026_10 };
      }
      return { available: false as const, reason: '该月份暂无已归档的月度总结' };
    },
    [scenario],
  );

  const act = useCallback((text: string) => setLastAction(text), []);
  const onOpenPermissionSettings = useCallback(() => act('请求打开系统授权设置'), [act]);

  return (
    <>
      <nav className="demoBar" aria-label="预览工具栏">
        <label>
          场景
          <select value={scenario} onChange={(e) => switchScenario(e.target.value as ScenarioName)}>
            {SCENARIOS.map((s) => (
              <option key={s} value={s}>
                {s === 'rebaseline-suggested' ? '重新基线建议' : s}
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
        <SensePanel
          model={model}
          onPause={(p) => {
            setModel((m) => ({ ...m, paused: p }));
            act(p ? '已暂停感知' : '已恢复感知');
          }}
          onToggleTitles={(on) => {
            setModel((m) => ({ ...m, sendTitles: on }));
            act(on ? '窗口标题发给模型' : '窗口标题已隐藏');
          }}
          onToggleGlobalFileWatch={(on) => {
            setModel((m) => {
              const cur = m.state.env.globalFileWatch;
              if (!cur?.value) return m;
              return {
                ...m,
                state: {
                  ...m.state,
                  env: {
                    ...m.state.env,
                    globalFileWatch: {
                      ...cur,
                      value: {
                        ...cur.value,
                        enabled: on,
                        status: on ? (cur.value.degraded ? 'degraded' : 'running') : 'disabled',
                      },
                    },
                  },
                },
              };
            });
            act(on ? '开启全盘文件监视' : '关闭全盘文件监视');
          }}
          onRetryGlobalFileWatch={async () => {
            setModel((m) => {
              const cur = m.state.env.globalFileWatch;
              if (!cur?.value) return m;
              return {
                ...m,
                state: {
                  ...m.state,
                  env: {
                    ...m.state.env,
                    globalFileWatch: {
                      ...cur,
                      status: 'ok',
                      reason: undefined,
                      value: {
                        ...cur.value,
                        enabled: true,
                        status: cur.value.degraded ? 'degraded' : 'running',
                        reason: undefined,
                        retryAt: undefined,
                      },
                    },
                  },
                },
              };
            });
            act('重试全盘文件监视');
          }}
          onAddFileExclusion={async (pattern) => {
            setModel((m) => {
              const cur = m.state.env.globalFileWatch;
              if (!cur?.value) return m;
              const next = cur.value.exclusions.includes(pattern)
                ? cur.value.exclusions
                : [...cur.value.exclusions, pattern];
              return {
                ...m,
                state: {
                  ...m.state,
                  env: { ...m.state.env, globalFileWatch: { ...cur, value: { ...cur.value, exclusions: next } } },
                },
              };
            });
            act(`添加排除项 ${pattern}`);
          }}
          onRemoveFileExclusion={async (pattern) => {
            setModel((m) => {
              const cur = m.state.env.globalFileWatch;
              if (!cur?.value) return m;
              return {
                ...m,
                state: {
                  ...m.state,
                  env: {
                    ...m.state.env,
                    globalFileWatch: {
                      ...cur,
                      value: { ...cur.value, exclusions: cur.value.exclusions.filter((x) => x !== pattern) },
                    },
                  },
                },
              };
            });
            act(`移除排除项 ${pattern}`);
          }}
          onToggleRule={(id, enabled) => {
            setModel((m) => ({
              ...m,
              rules: m.rules.map((r) => (r.id === id ? { ...r, enabled } : r)),
            }));
            act(`${enabled ? '启用' : '停用'}规则 ${id}`);
          }}
          onConfirmRule={(id) => {
            setModel((m) => ({
              ...m,
              rules: m.rules.map((r) => (r.id === id ? { ...r, confirmed: true } : r)),
            }));
            act(`确认规则 ${id}`);
          }}
          onDeleteRule={(id) => {
            setModel((m) => ({ ...m, rules: m.rules.filter((r) => r.id !== id) }));
            act(`删除/拒绝规则 ${id}`);
          }}
          onOpenPermissionSettings={onOpenPermissionSettings}
          onLockParam={(key, locked) => {
            setModel((m) => ({
              ...m,
              tuning: m.tuning && {
                ...m.tuning,
                parameters: m.tuning.parameters.map((p) => (p.key === key ? { ...p, locked } : p)),
              },
            }));
            act(`${locked ? '锁定' : '解锁'}参数 ${key}`);
          }}
          onRevertTuning={(id) => {
            // 预览示意：把参数值退回 previous 并把日志标为已撤销；
            // 真实宿主才拥有调参护栏（锁定不阻止用户撤销）。
            setModel((m) => {
              if (!m.tuning) return m;
              const entry = m.tuning.log.find((e) => e.id === id);
              if (!entry) return m;
              return {
                ...m,
                tuning: {
                  ...m.tuning,
                  parameters: m.tuning.parameters.map((p) =>
                    p.key === entry.paramKey ? { ...p, value: entry.previous } : p,
                  ),
                  log: m.tuning.log.map((e) => (e.id === id ? { ...e, reverted: true } : e)),
                },
              };
            });
            act(`撤销调整 ${id}`);
          }}
          onFeedback={(signalId, value) => {
            setModel((m) => ({
              ...m,
              events: m.events.map((e) => (e.signal.id === signalId ? { ...e, feedback: value } : e)),
            }));
            act(`反馈${value === 'useful' ? '有用' : '噪音'} ${signalId}`);
          }}
          onResumeTuning={async () => {
            setModel((m) => ({
              ...m,
              tuning: m.tuning && { ...m.tuning, disabled: undefined },
            }));
            act('恢复 AI 调参');
          }}
          onResetTuning={async () => {
            setModel((m) => ({
              ...m,
              tuning: m.tuning && { parameters: [], log: [] },
            }));
            act('重置调参');
          }}
          onAcceptRebaseline={async (id) => {
            setModel((m) => ({
              ...m,
              tuning: m.tuning && {
                ...m.tuning,
                suggestions: m.tuning.suggestions?.filter((s) => s.id !== id),
              },
            }));
            act(`确认重新基线 ${id}`);
          }}
          onListMonths={onListMonths}
          onLoadMonthly={onLoadMonthly}
          onClearHistory={async () => {
            setHistoryCleared(true);
            setModel((m) => ({ ...m, events: [], timeline: undefined }));
            act('清除历史数据');
          }}
        />
      </main>
    </>
  );
}
