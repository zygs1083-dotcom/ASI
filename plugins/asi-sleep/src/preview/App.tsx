import { useEffect, useState } from 'react';
import { makeSleepScenario, SLEEP_SCENARIOS, type SleepScenarioName } from '../client/mock-scenarios.js';
import { SleepPanel } from '../client/SleepPanel.js';
import type { MemoryKind, MemoryViewItem, SleepConsolidationRecord, SleepPanelModel } from '../shared/types.js';

type Theme = 'light' | 'dark';

function readQuery(): { scenario: SleepScenarioName; theme: Theme } {
  const q = new URLSearchParams(location.search);
  const s = q.get('scenario');
  const t = q.get('theme');
  return {
    scenario: (SLEEP_SCENARIOS as readonly string[]).includes(s ?? '') ? (s as SleepScenarioName) : 'healthy-vault',
    theme: t === 'dark' ? 'dark' : 'light',
  };
}

function applyTheme(theme: Theme) {
  if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
  else document.body.removeAttribute('data-ds-dark-theme');
  document.documentElement.style.colorScheme = theme;
}

function recomputeCounts(memories: readonly MemoryViewItem[]): {
  countsByKind: Record<MemoryKind, number>;
  pinnedCount: number;
  totalMemories: number;
} {
  const countsByKind: Record<MemoryKind, number> = {
    preference: 0,
    decision: 0,
    pitfall: 0,
    episode: 0,
  };
  let pinnedCount = 0;
  for (const m of memories) {
    countsByKind[m.kind] += 1;
    if (m.pinned) pinnedCount += 1;
  }
  return { countsByKind, pinnedCount, totalMemories: memories.length };
}

export function App() {
  const initial = readQuery();
  const [scenario, setScenario] = useState<SleepScenarioName>(initial.scenario);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [model, setModel] = useState<SleepPanelModel>(() => makeSleepScenario(initial.scenario));
  const [lastAction, setLastAction] = useState('');

  useEffect(() => applyTheme(theme), [theme]);

  const switchScenario = (name: SleepScenarioName) => {
    setScenario(name);
    setModel(makeSleepScenario(name));
  };

  return (
    <>
      <nav className="demoBar" aria-label="预览工具栏">
        <label>
          场景
          <select value={scenario} onChange={(e) => switchScenario(e.target.value as SleepScenarioName)}>
            {SLEEP_SCENARIOS.map((s) => (
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
        <span className="demoAction">{lastAction}</span>
      </nav>
      <main className="stage">
        <SleepPanel
          model={model}
          onConsolidateNow={async () => {
            const rec: SleepConsolidationRecord = {
              id: `sleep_${Date.now()}`,
              at: model.now,
              trigger: 'manual',
              turnsProcessed: model.drive.unconsolidatedTurns,
              nremCandidates: 2,
              createdCount: 1,
              mergedCount: 1,
              conflictsResolved: 0,
              prunedCount: 0,
              linksUpdated: 1,
              durationMs: 28,
              summary: `整合 ${model.drive.unconsolidatedTurns} 轮对话 · 新增 1 / 强化 1`,
            };
            setModel((prev) => ({
              ...prev,
              drive: {
                ...prev.drive,
                satisfaction: 100,
                urgency: 0,
                zone: 'comfortable',
                sleepy: false,
                unconsolidatedTurns: 0,
                lastSleepAt: prev.now,
                summary: '对话记忆均已整合，睡眠稳态充沛',
              },
              recentConsolidations: [rec, ...prev.recentConsolidations],
            }));
            setLastAction('已完成立即睡眠整合');
            return rec;
          }}
          onToggleAutoSleepPaused={async (paused) => {
            setModel((prev) => ({ ...prev, autoSleepPaused: paused }));
            setLastAction(paused ? '已暂停自动睡眠' : '已恢复自动睡眠');
          }}
          onCreateMemory={async (input) => {
            const item: MemoryViewItem = {
              id: `mem_custom_${Date.now()}`,
              kind: input.kind,
              title: input.title,
              content: input.content,
              tags: input.tags ?? [],
              pinned: Boolean(input.pinned),
              confidence: 1,
              sourceSessionIds: ['manual'],
              evidenceCount: 1,
              recallCount: 0,
              createdAt: model.now,
              updatedAt: model.now,
              retention: 1,
              fsrs: {
                stability: 8,
                difficulty: 4,
                elapsedDays: 0,
                scheduledDays: 8,
                learningSteps: 0,
                reps: 1,
                lapses: 0,
                state: 2,
                due: model.now + 8 * 86_400_000,
                lastReview: model.now,
              },
            };
            setModel((prev) => {
              const nextMemories = [item, ...prev.memories];
              return { ...prev, memories: nextMemories, ...recomputeCounts(nextMemories) };
            });
            setLastAction(`新建记忆 ${input.title}`);
            return item;
          }}
          onUpdateMemory={async (id, patch) => {
            setModel((prev) => {
              const nextMemories = prev.memories.map((m) => {
                if (m.id !== id) return m;
                const nextPinned = patch.pinned !== undefined ? Boolean(patch.pinned) : m.pinned;
                return {
                  ...m,
                  kind: patch.kind ?? m.kind,
                  title: patch.title ?? m.title,
                  content: patch.content ?? m.content,
                  tags: patch.tags ?? m.tags,
                  pinned: nextPinned,
                  retention: nextPinned ? 1 : m.retention,
                  updatedAt: prev.now,
                };
              });
              return { ...prev, memories: nextMemories, ...recomputeCounts(nextMemories) };
            });
            setLastAction(`更新记忆 ${id}`);
            return undefined;
          }}
          onTogglePin={async (id, pinned) => {
            setModel((prev) => {
              const nextMemories = prev.memories.map((m) =>
                m.id === id ? { ...m, pinned, retention: pinned ? 1 : 0.85 } : m,
              );
              return { ...prev, memories: nextMemories, ...recomputeCounts(nextMemories) };
            });
            setLastAction(`${pinned ? '置顶' : '取消置顶'} ${id}`);
            return undefined;
          }}
          onDeleteMemory={async (id) => {
            setModel((prev) => {
              const nextMemories = prev.memories.filter((m) => m.id !== id);
              return { ...prev, memories: nextMemories, ...recomputeCounts(nextMemories) };
            });
            setLastAction(`删除记忆 ${id}`);
          }}
        />
      </main>
    </>
  );
}
