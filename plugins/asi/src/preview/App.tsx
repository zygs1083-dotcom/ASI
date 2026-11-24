import { useEffect, useRef, useState } from 'react';
import { type AsiMainTab, AsiPanel } from '../client/AsiPanel.tsx';
import { ASI_UNIFIED_SCENARIOS, type AsiUnifiedScenarioName, makeUnifiedScenario } from '../client/mock-scenarios.ts';
import { makeDreamScenario } from '../dream/mock-scenarios.ts';
import { searchDreamInsights } from '../dream/shared/search.ts';
import {
  DREAM_INSIGHT_KIND_LABELS,
  type DreamCycleRecord,
  type DreamInsightViewItem,
  type DreamPanelModel,
} from '../dream/shared/types.ts';
import { parseSkillMarkdown, renderSkillMarkdown, toValidSkillSlug } from '../growth/shared/skill-spec.ts';
import type {
  ArchivedSkillViewItem,
  GrowthPanelModel,
  GrowthSynthesisRecord,
  SkillDraftViewItem,
  SkillViewItem,
} from '../growth/shared/types.ts';
import type { AsiPanelModel } from '../host/dsh/wire-types.ts';
import { formatTriggerSummary } from '../intuition/host/prospective-evaluator.ts';
import { SomaticMatcher } from '../intuition/host/somatic-matcher.ts';
import {
  type IntuitionPanelModel,
  PROSPECTIVE_EVENT_KINDS,
  type ProspectiveIntention,
  type ProspectiveTriggerSpec,
} from '../intuition/shared/types.ts';
import { searchMemoryItems } from '../sleep/shared/search.ts';
import {
  MEMORY_KINDS,
  type MemoryKind,
  type MemoryViewItem,
  type SleepConsolidationRecord,
  type SleepPanelModel,
} from '../sleep/shared/types.ts';
import { buildTactGuidance } from '../tom/host/evaluator.ts';
import { PARTNER_STATE_LABELS, type TomPanelModel } from '../tom/shared/types.ts';

type Theme = 'light' | 'dark';

function readQuery(): {
  scenario: AsiUnifiedScenarioName;
  theme: Theme;
  tab: AsiMainTab;
  failActions: boolean;
  overflowVault: boolean;
} {
  const q = new URLSearchParams(location.search);
  const s = q.get('scenario');
  const t = q.get('theme');
  const tab = q.get('tab');
  return {
    scenario: (ASI_UNIFIED_SCENARIOS as readonly string[]).includes(s ?? '')
      ? (s as AsiUnifiedScenarioName)
      : 'pending-approvals',
    theme: t === 'dark' ? 'dark' : 'light',
    tab: tab === 'memory' || tab === 'skills' ? tab : 'care',
    failActions: q.get('failActions') === '1',
    overflowVault: q.get('overflowVault') === '1',
  };
}

function applyTheme(theme: Theme) {
  if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
  else document.body.removeAttribute('data-ds-dark-theme');
  document.documentElement.style.colorScheme = theme;
}

function withGrowthRecount(model: GrowthPanelModel): GrowthPanelModel {
  let activeCount = 0;
  let disabledCount = 0;
  let staleCount = 0;
  for (const s of model.skills) {
    if (s.status === 'active') activeCount += 1;
    else disabledCount += 1;
    if (s.stale) staleCount += 1;
  }
  return {
    ...model,
    draftCount: model.drafts.length,
    activeCount,
    disabledCount,
    archivedCount: model.archivedSkills.length,
    staleCount,
  };
}

function withDreamRecount(model: DreamPanelModel): DreamPanelModel {
  let openCount = 0;
  let adoptedCount = 0;
  let promotedCount = 0;
  let dismissedCount = 0;
  for (const item of model.insights) {
    if (item.status === 'open') openCount += 1;
    else if (item.status === 'adopted') adoptedCount += 1;
    else if (item.status === 'promoted') promotedCount += 1;
    else if (item.status === 'dismissed') dismissedCount += 1;
  }
  return {
    ...model,
    openCount,
    adoptedCount,
    promotedCount,
    dismissedCount,
    totalInsights: model.insights.length,
    drive: {
      ...model.drive,
      openInsightCount: openCount,
    },
  };
}

function withSleepRecount(model: SleepPanelModel, backingMemories?: readonly MemoryViewItem[]): SleepPanelModel {
  const all = backingMemories ?? model.memories;
  const countsByKind: Record<MemoryKind, number> = {
    preference: 0,
    decision: 0,
    pitfall: 0,
    episode: 0,
  };
  for (const k of MEMORY_KINDS) countsByKind[k] = 0;
  let pinnedCount = 0;
  for (const m of all) {
    countsByKind[m.kind] += 1;
    if (m.pinned) pinnedCount += 1;
  }
  return {
    ...model,
    countsByKind,
    totalMemories: all.length,
    pinnedCount,
    memories: backingMemories ? all.slice(0, 4) : model.memories,
  };
}

function withIntuitionRecount(model: IntuitionPanelModel): IntuitionPanelModel {
  let pendingCount = 0;
  let surfacedCount = 0;
  let fulfilledCount = 0;
  for (const item of model.intentions) {
    if (item.status === 'pending' || item.status === 'snoozed') pendingCount += 1;
    else if (item.status === 'surfaced') surfacedCount += 1;
    else if (item.status === 'fulfilled') fulfilledCount += 1;
  }
  return {
    ...model,
    pendingCount,
    surfacedCount,
    fulfilledCount,
    drive: {
      ...model.drive,
      pendingCount,
      surfacedCount,
    },
  };
}

const previewMatcher = new SomaticMatcher();

function buildOverflowMemories(base: readonly MemoryViewItem[], now: number): MemoryViewItem[] {
  const extra: MemoryViewItem[] = Array.from({ length: 12 }, (_, idx) => ({
    id: `mem_overflow_${idx + 1}`,
    kind: idx === 0 ? 'pitfall' : idx % 2 === 0 ? 'decision' : 'episode',
    title: idx === 0 ? '溢出一页的深层记忆条目' : `归档长尾记忆 #${idx + 1}`,
    content:
      idx === 0
        ? '用于验证 totalMemories > memories.length 时远端检索后执行置顶/编辑/删除实时刷新。 keyword=overflow-vault-hit'
        : `长尾记忆正文 #${idx + 1}`,
    tags: idx === 0 ? ['overflow'] : ['tail'],
    pinned: false,
    confidence: 0.9,
    sourceSessionIds: ['sess-overflow'],
    evidenceCount: 1,
    recallCount: 0,
    createdAt: now - (idx + 5) * 60_000,
    updatedAt: now - (idx + 5) * 60_000,
    retention: 0.72,
    fsrs: {
      stability: 10,
      difficulty: 3.5,
      elapsedDays: 2,
      scheduledDays: 10,
      learningSteps: 0,
      reps: 1,
      lapses: 0,
      state: 2,
      due: now + 8 * 86_400_000,
      lastReview: now - 2 * 86_400_000,
    },
  }));
  return [...base, ...extra];
}

export function App() {
  const initial = readQuery();
  const [scenario, setScenario] = useState<AsiUnifiedScenarioName>(initial.scenario);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const initialModel = makeUnifiedScenario(initial.scenario);
  const initialOverflow = initial.overflowVault
    ? buildOverflowMemories(initialModel.sleep.memories, initialModel.sleep.now)
    : null;
  const overflowVaultRef = useRef<MemoryViewItem[] | null>(initialOverflow);
  const [model, setModel] = useState<AsiPanelModel>(() =>
    initialOverflow ? { ...initialModel, sleep: withSleepRecount(initialModel.sleep, initialOverflow) } : initialModel,
  );
  const [lastAction, setLastAction] = useState('');

  useEffect(() => applyTheme(theme), [theme]);

  const switchScenario = (name: AsiUnifiedScenarioName) => {
    setScenario(name);
    const next = makeUnifiedScenario(name);
    if (initial.overflowVault) {
      const all = buildOverflowMemories(next.sleep.memories, next.sleep.now);
      overflowVaultRef.current = all;
      setModel({ ...next, sleep: withSleepRecount(next.sleep, all) });
    } else {
      overflowVaultRef.current = null;
      setModel(next);
    }
  };

  return (
    <>
      <nav className="demoBar" aria-label="预览工具栏">
        <label>
          场景
          <select value={scenario} onChange={(e) => switchScenario(e.target.value as AsiUnifiedScenarioName)}>
            {ASI_UNIFIED_SCENARIOS.map((s) => (
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
        <AsiPanel
          model={model}
          initialTab={initial.tab}
          onPause={async (paused) => {
            if (initial.failActions) throw new Error('模拟连接中断：暂停切换失败');
            setModel((prev) => ({
              ...prev,
              needs: { ...prev.needs, paused },
              tom: { ...prev.tom, sensePaused: paused },
            }));
            setLastAction(paused ? '已暂停感知与自维护' : '已恢复感知与自维护');
          }}
          onToggleTitles={async (enabled) => {
            if (initial.failActions) throw new Error('模拟连接中断：窗口标题开关失败');
            setModel((prev) => ({ ...prev, needs: { ...prev.needs, sendTitles: enabled } }));
            setLastAction(enabled ? '已开启窗口标题发给模型' : '已隐藏窗口标题');
          }}
          onOpenPermissionSettings={async () => {
            if (initial.failActions) throw new Error('模拟连接中断：打开权限设置失败');
            setLastAction('已请求打开辅助功能权限设置');
          }}
          onApproveHelp={async (cardId) => {
            if (initial.failActions) throw new Error('模拟连接中断：批准求助卡失败');
            setModel((prev) => ({
              ...prev,
              needs: {
                ...prev.needs,
                helpCards: prev.needs.helpCards.map((c) =>
                  c.id === cardId ? { ...c, status: 'resolved', updatedAt: prev.needs.now } : c,
                ),
              },
            }));
            setLastAction(`已批准求助卡 ${cardId}`);
          }}
          onDismissHelp={async (cardId) => {
            if (initial.failActions) throw new Error('模拟连接中断：忽略求助卡失败');
            setModel((prev) => ({
              ...prev,
              needs: {
                ...prev.needs,
                helpCards: prev.needs.helpCards.map((c) =>
                  c.id === cardId ? { ...c, status: 'dismissed', updatedAt: prev.needs.now } : c,
                ),
              },
            }));
            setLastAction(`已忽略求助卡 ${cardId}`);
          }}
          onOpenMaintenanceSession={async () => {
            if (initial.failActions) throw new Error('模拟连接中断：打开自维护会话失败');
            setLastAction('已打开自维护会话');
          }}
          onTriggerCheck={async () => {
            if (initial.failActions) throw new Error('模拟连接中断：立即自检失败');
            setLastAction('已触发立即稳态自检');
          }}
          onConsolidateNow={async () => {
            if (initial.failActions) throw new Error('模拟连接中断：立即睡眠整合失败');
            const turns = Math.max(1, model.sleep.drive.unconsolidatedTurns || 12);
            const rec: SleepConsolidationRecord = {
              id: `sleep_${Date.now()}`,
              at: model.sleep.now,
              trigger: 'manual',
              turnsProcessed: turns,
              nremCandidates: 3,
              createdCount: 1,
              mergedCount: 1,
              conflictsResolved: 0,
              prunedCount: 0,
              linksUpdated: 1,
              durationMs: 28,
              summary: `整合 ${turns} 轮对话 · 新增 1 / 强化 1`,
            };
            setModel((prev) => ({
              ...prev,
              sleep: {
                ...prev.sleep,
                drive: {
                  ...prev.sleep.drive,
                  satisfaction: 100,
                  urgency: 0,
                  zone: 'comfortable',
                  sleepy: false,
                  unconsolidatedTurns: 0,
                  lastSleepAt: prev.sleep.now,
                  summary: '睡眠整合已完成，记忆库处于稳态舒适',
                },
                recentConsolidations: [rec, ...prev.sleep.recentConsolidations],
              },
            }));
            setLastAction('已完成立即睡眠整合');
            return rec;
          }}
          onToggleAutoSleepPaused={async (paused) => {
            if (initial.failActions) throw new Error('模拟连接中断：暂停自动睡眠失败');
            setModel((prev) => ({ ...prev, sleep: { ...prev.sleep, autoSleepPaused: paused } }));
            setLastAction(paused ? '已暂停自动睡眠' : '已恢复自动睡眠');
          }}
          onCreateMemory={async (input) => {
            const created: MemoryViewItem = {
              id: `mem_${Date.now()}`,
              kind: input.kind,
              title: input.title,
              content: input.content,
              tags: input.tags ?? [],
              ...(input.topicKey ? { topicKey: input.topicKey } : {}),
              pinned: Boolean(input.pinned),
              confidence: 0.95,
              sourceSessionIds: ['manual'],
              evidenceCount: 1,
              recallCount: 0,
              createdAt: model.sleep.now,
              updatedAt: model.sleep.now,
              retention: 1,
              fsrs: {
                stability: 14,
                difficulty: 3.5,
                elapsedDays: 0,
                scheduledDays: 14,
                learningSteps: 0,
                reps: 1,
                lapses: 0,
                state: 2,
                due: model.sleep.now + 14 * 86_400_000,
                lastReview: model.sleep.now,
              },
            };
            setModel((prev) => {
              if (overflowVaultRef.current) {
                overflowVaultRef.current = [created, ...overflowVaultRef.current];
                return { ...prev, sleep: withSleepRecount(prev.sleep, overflowVaultRef.current) };
              }
              return {
                ...prev,
                sleep: withSleepRecount({
                  ...prev.sleep,
                  memories: [created, ...prev.sleep.memories],
                }),
              };
            });
            setLastAction(`新建记忆 ${created.title}`);
            return created;
          }}
          onUpdateMemory={async (id, patch) => {
            let updatedOut: MemoryViewItem | undefined;
            const applyPatch = (m: MemoryViewItem, now: number): MemoryViewItem => {
              if (m.id !== id) return m;
              const next: MemoryViewItem = {
                ...m,
                ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                ...(patch.content !== undefined ? { content: patch.content } : {}),
                ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
                ...(patch.pinned !== undefined
                  ? { pinned: patch.pinned, retention: patch.pinned ? 1 : m.retention }
                  : {}),
                updatedAt: now,
              };
              updatedOut = next;
              return next;
            };
            setModel((prev) => {
              if (overflowVaultRef.current) {
                overflowVaultRef.current = overflowVaultRef.current.map((m) => applyPatch(m, prev.sleep.now));
                return { ...prev, sleep: withSleepRecount(prev.sleep, overflowVaultRef.current) };
              }
              const nextMemories = prev.sleep.memories.map((m) => applyPatch(m, prev.sleep.now));
              return { ...prev, sleep: withSleepRecount({ ...prev.sleep, memories: nextMemories }) };
            });
            setLastAction(`编辑记忆 ${id}`);
            return updatedOut;
          }}
          onTogglePin={async (id, pinned) => {
            if (initial.failActions) throw new Error('模拟连接中断：置顶切换失败');
            let updatedOut: MemoryViewItem | undefined;
            const applyPin = (m: MemoryViewItem, now: number): MemoryViewItem => {
              if (m.id !== id) return m;
              const next: MemoryViewItem = {
                ...m,
                pinned,
                retention: pinned ? 1 : 0.88,
                updatedAt: now,
              };
              updatedOut = next;
              return next;
            };
            setModel((prev) => {
              if (overflowVaultRef.current) {
                overflowVaultRef.current = overflowVaultRef.current.map((m) => applyPin(m, prev.sleep.now));
                return { ...prev, sleep: withSleepRecount(prev.sleep, overflowVaultRef.current) };
              }
              const nextMemories = prev.sleep.memories.map((m) => applyPin(m, prev.sleep.now));
              return { ...prev, sleep: withSleepRecount({ ...prev.sleep, memories: nextMemories }) };
            });
            setLastAction(`${pinned ? '置顶' : '取消置顶'} ${id}`);
            return updatedOut;
          }}
          onDeleteMemory={async (id) => {
            if (initial.failActions) throw new Error('模拟连接中断：删除记忆失败');
            setModel((prev) => {
              if (overflowVaultRef.current) {
                overflowVaultRef.current = overflowVaultRef.current.filter((m) => m.id !== id);
                return { ...prev, sleep: withSleepRecount(prev.sleep, overflowVaultRef.current) };
              }
              return {
                ...prev,
                sleep: withSleepRecount({
                  ...prev.sleep,
                  memories: prev.sleep.memories.filter((m) => m.id !== id),
                }),
              };
            });
            setLastAction(`删除记忆 ${id}`);
          }}
          onSearchMemories={async (query, kind) => {
            const source = overflowVaultRef.current ?? model.sleep.memories;
            return searchMemoryItems(source, query, {
              ...(kind ? { kind } : {}),
              includeLowRetention: true,
              limit: 200,
            });
          }}
          onSynthesizeNow={async () => {
            if (initial.failActions) throw new Error('模拟连接中断：立即提炼失败');
            const newMarkdown = renderSkillMarkdown({
              name: 'vitest-cordis-lifecycle',
              description: 'Verify Cordis plugin startup and clean disposal in integration suites.',
              whenToUse: 'Use when writing Cordis integration tests.',
              license: 'MIT',
              body: '# Cordis Lifecycle Testing\n\n## Standard Procedure\n1. Verify clean disposal in finally.',
            });
            const newDraft: SkillDraftViewItem = {
              id: `draft_syn_${Date.now()}`,
              name: 'vitest-cordis-lifecycle',
              description: 'Verify Cordis plugin startup and clean disposal in integration suites.',
              whenToUse: 'Use when writing Cordis integration tests.',
              markdown: newMarkdown,
              scope: 'global',
              targetVersion: 1,
              isRevision: false,
              topicKey: 'vitest-cordis',
              evidenceIds: ['mem_a', 'mem_b', 'mem_c'],
              memoryCount: 3,
              trajectoryCount: 2,
              evidenceSummary: '聚合 3 条高保留率记忆与 2 条多步排障轨迹',
              createdAt: model.growth.now,
              updatedAt: model.growth.now,
              trigger: 'manual',
            };
            const rec: GrowthSynthesisRecord = {
              id: `growth_${Date.now()}`,
              at: model.growth.now,
              trigger: 'manual',
              clustersInspected: 1,
              draftsCreated: 1,
              revisionsCreated: 0,
              durationMs: 19,
              summary: '提炼 1 份待审 SKILL.md 草案（新建 1 / 修订 0），等待人工批准启用',
            };
            setModel((prev) => ({
              ...prev,
              growth: withGrowthRecount({
                ...prev.growth,
                drive: {
                  ...prev.growth.drive,
                  satisfaction: 100,
                  urgency: 0,
                  zone: 'comfortable',
                  readyToSynthesize: false,
                  readyClusters: 0,
                  lastSynthesisAt: prev.growth.now,
                  summary: '已完成手动提炼，待人工审批草案',
                },
                drafts: [newDraft, ...prev.growth.drafts],
                recentSyntheses: [rec, ...prev.growth.recentSyntheses],
              }),
            }));
            setLastAction('已完成立即提炼技能');
            return rec;
          }}
          onToggleAutoGrowthPaused={async (paused) => {
            if (initial.failActions) throw new Error('模拟连接中断：暂停提炼开关失败');
            setModel((prev) => ({ ...prev, growth: { ...prev.growth, autoGrowthPaused: paused } }));
            setLastAction(paused ? '已暂停自动提炼' : '已恢复自动提炼');
          }}
          onCreateManualDraft={async (input) => {
            const slug = toValidSkillSlug(input.name, 'skill');
            const md = renderSkillMarkdown({
              name: slug,
              description: input.description,
              ...(input.whenToUse ? { whenToUse: input.whenToUse } : {}),
              license: 'MIT',
              body: input.body,
            });
            const created: SkillDraftViewItem = {
              id: `draft_manual_${Date.now()}`,
              name: slug,
              description: input.description,
              ...(input.whenToUse ? { whenToUse: input.whenToUse } : {}),
              markdown: md,
              scope: input.scope ?? 'global',
              ...(input.workspacePath
                ? { workspacePath: input.workspacePath, workspaceDisplay: input.workspacePath }
                : {}),
              targetVersion: 1,
              isRevision: false,
              topicKey: slug,
              evidenceIds: ['manual'],
              memoryCount: 0,
              trajectoryCount: 0,
              evidenceSummary: '手动新建待审技能草案',
              createdAt: model.growth.now,
              updatedAt: model.growth.now,
              trigger: 'manual',
            };
            setModel((prev) => ({
              ...prev,
              growth: withGrowthRecount({ ...prev.growth, drafts: [created, ...prev.growth.drafts] }),
            }));
            setLastAction(`新建草案 ${slug}`);
            return created;
          }}
          onUpdateDraft={async (draftId, patch) => {
            let out: SkillDraftViewItem | undefined;
            setModel((prev) => {
              const nextDrafts = prev.growth.drafts.map((d) => {
                if (d.id !== draftId) return d;
                const parsed = parseSkillMarkdown(patch.markdown);
                const nextScope = patch.scope ?? d.scope;
                const nextWs = nextScope === 'workspace' ? (patch.workspacePath ?? d.workspacePath) : undefined;
                const wsDisp = prev.growth.knownWorkspaces.find((w) => w.path === nextWs)?.display ?? nextWs;
                const updated: SkillDraftViewItem = {
                  ...d,
                  name: parsed.document?.name ?? d.name,
                  description: parsed.document?.description ?? d.description,
                  markdown: patch.markdown,
                  scope: nextScope,
                  ...(nextWs ? { workspacePath: nextWs, workspaceDisplay: wsDisp } : {}),
                  updatedAt: prev.growth.now,
                };
                if (!nextWs) {
                  delete updated.workspacePath;
                  delete updated.workspaceDisplay;
                }
                out = updated;
                return updated;
              });
              return { ...prev, growth: withGrowthRecount({ ...prev.growth, drafts: nextDrafts }) };
            });
            setLastAction(`更新草案 ${draftId}`);
            return out;
          }}
          onApproveDraft={async (draftId) => {
            if (initial.failActions) throw new Error('模拟连接中断：批准草案失败');
            let approvedOut: SkillViewItem | undefined;
            setModel((prev) => {
              const draft = prev.growth.drafts.find((d) => d.id === draftId);
              if (!draft) return prev;
              const existing = prev.growth.skills.find((s) => s.name === draft.name);
              const nextSkill: SkillViewItem = {
                name: draft.name,
                version: existing ? Math.max(existing.version + 1, draft.targetVersion) : draft.targetVersion,
                status: 'active',
                scope: draft.scope,
                ...(draft.workspacePath ? { workspacePath: draft.workspacePath } : {}),
                ...(draft.workspaceDisplay ? { workspaceDisplay: draft.workspaceDisplay } : {}),
                description: draft.description,
                ...(draft.whenToUse ? { whenToUse: draft.whenToUse } : {}),
                markdown: draft.markdown,
                topicKey: draft.topicKey,
                evidenceIds: draft.evidenceIds,
                approvedAt: existing?.approvedAt ?? prev.growth.now,
                updatedAt: prev.growth.now,
                invocationCount: existing?.invocationCount ?? 0,
                lastInvokedAt: existing?.lastInvokedAt ?? null,
                evaluatedTurns: existing?.evaluatedTurns ?? 0,
                completedTurns: existing?.completedTurns ?? 0,
                turnCompletionRate: existing?.turnCompletionRate ?? null,
                stale: false,
                daysSinceLastUse: 0,
                exportedWorkspaces: existing?.exportedWorkspaces ?? [],
              };
              approvedOut = nextSkill;
              const restSkills = prev.growth.skills.filter((s) => s.name !== draft.name);
              return {
                ...prev,
                growth: withGrowthRecount({
                  ...prev.growth,
                  drafts: prev.growth.drafts.filter((d) => d.id !== draftId),
                  skills: [nextSkill, ...restSkills],
                }),
              };
            });
            setLastAction(`已批准 ${draftId}`);
            return approvedOut;
          }}
          onRejectDraft={async (draftId) => {
            setModel((prev) => ({
              ...prev,
              growth: withGrowthRecount({
                ...prev.growth,
                drafts: prev.growth.drafts.filter((d) => d.id !== draftId),
              }),
            }));
            setLastAction(`已驳回 ${draftId}`);
          }}
          onUpdateSkill={async (name, patch) => {
            let out: SkillViewItem | undefined;
            setModel((prev) => {
              const nextSkills = prev.growth.skills.map((s) => {
                if (s.name !== name) return s;
                const parsed = parseSkillMarkdown(patch.markdown);
                const updated: SkillViewItem = {
                  ...s,
                  description: parsed.document?.description ?? s.description,
                  markdown: patch.markdown,
                  updatedAt: prev.growth.now,
                };
                out = updated;
                return updated;
              });
              return { ...prev, growth: withGrowthRecount({ ...prev.growth, skills: nextSkills }) };
            });
            setLastAction(`编辑技能 ${name}`);
            return out;
          }}
          onSetSkillScope={async (name, input) => {
            let out: SkillViewItem | undefined;
            setModel((prev) => {
              const nextSkills = prev.growth.skills.map((s) => {
                if (s.name !== name) return s;
                const wsDisp =
                  prev.growth.knownWorkspaces.find((w) => w.path === input.workspacePath)?.display ??
                  input.workspacePath;
                const updated: SkillViewItem = {
                  ...s,
                  scope: input.scope,
                  ...(input.scope === 'workspace' && input.workspacePath
                    ? { workspacePath: input.workspacePath, workspaceDisplay: wsDisp }
                    : {}),
                };
                if (input.scope === 'global') {
                  delete updated.workspacePath;
                  delete updated.workspaceDisplay;
                }
                out = updated;
                return updated;
              });
              return { ...prev, growth: withGrowthRecount({ ...prev.growth, skills: nextSkills }) };
            });
            setLastAction(`切换作用域 ${name}`);
            return out;
          }}
          onSetSkillEnabled={async (name, enabled) => {
            let out: SkillViewItem | undefined;
            setModel((prev) => {
              const nextSkills = prev.growth.skills.map((s) => {
                if (s.name !== name) return s;
                const updated: SkillViewItem = {
                  ...s,
                  status: enabled ? 'active' : 'disabled',
                  stale: enabled ? s.stale : false,
                };
                out = updated;
                return updated;
              });
              return { ...prev, growth: withGrowthRecount({ ...prev.growth, skills: nextSkills }) };
            });
            setLastAction(`${enabled ? '启用' : '停用'} ${name}`);
            return out;
          }}
          onArchiveSkill={async (name) => {
            if (initial.failActions) throw new Error('模拟连接中断：归档技能失败');
            let out: ArchivedSkillViewItem | undefined;
            setModel((prev) => {
              const found = prev.growth.skills.find((s) => s.name === name);
              if (!found) return prev;
              const arch: ArchivedSkillViewItem = {
                name: found.name,
                version: found.version,
                scope: found.scope,
                ...(found.workspacePath ? { workspacePath: found.workspacePath } : {}),
                ...(found.workspaceDisplay ? { workspaceDisplay: found.workspaceDisplay } : {}),
                description: found.description,
                ...(found.whenToUse ? { whenToUse: found.whenToUse } : {}),
                markdown: found.markdown,
                topicKey: found.topicKey,
                approvedAt: found.approvedAt,
                archivedAt: prev.growth.now,
                invocationCount: found.invocationCount,
                lastInvokedAt: found.lastInvokedAt,
                turnCompletionRate: found.turnCompletionRate,
              };
              out = arch;
              return {
                ...prev,
                growth: withGrowthRecount({
                  ...prev.growth,
                  skills: prev.growth.skills.filter((s) => s.name !== name),
                  archivedSkills: [arch, ...prev.growth.archivedSkills],
                }),
              };
            });
            setLastAction(`归档技能 ${name}`);
            return out;
          }}
          onRestoreSkill={async (name) => {
            let out: SkillViewItem | undefined;
            setModel((prev) => {
              const arch = prev.growth.archivedSkills.find((a) => a.name === name);
              if (!arch) return prev;
              const restored: SkillViewItem = {
                name: arch.name,
                version: arch.version,
                status: 'active',
                scope: arch.scope,
                ...(arch.workspacePath ? { workspacePath: arch.workspacePath } : {}),
                ...(arch.workspaceDisplay ? { workspaceDisplay: arch.workspaceDisplay } : {}),
                description: arch.description,
                ...(arch.whenToUse ? { whenToUse: arch.whenToUse } : {}),
                markdown: arch.markdown,
                topicKey: arch.topicKey,
                evidenceIds: [],
                approvedAt: prev.growth.now,
                updatedAt: prev.growth.now,
                invocationCount: arch.invocationCount,
                lastInvokedAt: arch.lastInvokedAt,
                evaluatedTurns: 0,
                completedTurns: 0,
                turnCompletionRate: arch.turnCompletionRate,
                stale: false,
                daysSinceLastUse: 0,
                exportedWorkspaces: [],
              };
              out = restored;
              return {
                ...prev,
                growth: withGrowthRecount({
                  ...prev.growth,
                  skills: [restored, ...prev.growth.skills],
                  archivedSkills: prev.growth.archivedSkills.filter((a) => a.name !== name),
                }),
              };
            });
            setLastAction(`恢复技能 ${name}`);
            return out;
          }}
          onDeleteArchivedSkill={async (name) => {
            setModel((prev) => ({
              ...prev,
              growth: withGrowthRecount({
                ...prev.growth,
                archivedSkills: prev.growth.archivedSkills.filter((a) => a.name !== name),
              }),
            }));
            setLastAction(`删除归档 ${name}`);
          }}
          onExportSkillToWorkspace={async (name, ws) => {
            const disp = model.growth.knownWorkspaces.find((w) => w.path === ws)?.display ?? ws;
            const displayPath = `${disp}/.agents/skills/${name}/SKILL.md`;
            setModel((prev) => ({
              ...prev,
              growth: {
                ...prev.growth,
                skills: prev.growth.skills.map((s) =>
                  s.name === name ? { ...s, exportedWorkspaces: [...new Set([disp, ...s.exportedWorkspaces])] } : s,
                ),
              },
            }));
            setLastAction(`导出 ${name} -> ${displayPath}`);
            return {
              name,
              exportedPath: `${ws}/.agents/skills/${name}/SKILL.md`,
              displayPath,
              at: model.growth.now,
            };
          }}
          onToggleAutoIntuitionPaused={async (paused) => {
            if (initial.failActions) throw new Error('模拟连接中断：暂停直觉入队切换失败');
            setModel((prev) => ({
              ...prev,
              intuition: { ...prev.intuition, autoIntuitionPaused: paused },
            }));
            setLastAction(paused ? '已暂停自动直觉入队' : '已恢复自动直觉入队');
          }}
          onCreateProspectiveIntention={async (input) => {
            if (initial.failActions) throw new Error('模拟连接中断：新建前瞻提醒失败');
            const now = model.intuition.now;
            const trigger: ProspectiveTriggerSpec =
              input.triggerKind === 'time'
                ? { kind: 'time', dueAt: now + (input.delayMinutes ?? 30) * 60_000 }
                : input.triggerKind === 'context'
                  ? {
                      kind: 'context',
                      ...(input.workspaceMatch ? { workspaceMatch: input.workspaceMatch } : {}),
                      ...(input.keywordMatch ? { keywordMatch: input.keywordMatch } : {}),
                    }
                  : {
                      kind: 'event',
                      eventKind:
                        input.eventKind && PROSPECTIVE_EVENT_KINDS.includes(input.eventKind)
                          ? input.eventKind
                          : 'next_session',
                      ...(input.targetPattern ? { targetPattern: input.targetPattern } : {}),
                    };
            const created: ProspectiveIntention = {
              id: `pm_preview_${Date.now()}`,
              title: input.title,
              instruction: input.instruction,
              trigger,
              triggerSummary: formatTriggerSummary(trigger, now),
              priority: input.priority ?? 'normal',
              status: 'pending',
              createdAt: now,
              updatedAt: now,
              surfacedCount: 0,
            };
            setModel((prev) => ({
              ...prev,
              intuition: withIntuitionRecount({
                ...prev.intuition,
                intentions: [created, ...prev.intuition.intentions],
              }),
            }));
            setLastAction(`新建前瞻提醒 ${created.title}`);
            return created;
          }}
          onResolveProspectiveIntention={async (input) => {
            if (initial.failActions) throw new Error('模拟连接中断：处理前瞻提醒失败');
            let updatedOut: ProspectiveIntention | undefined;
            setModel((prev) => {
              const now = prev.intuition.now;
              const nextIntentions = prev.intuition.intentions.map((item) => {
                if (item.id !== input.id) return item;
                const nextStatus =
                  input.action === 'fulfill' ? 'fulfilled' : input.action === 'snooze' ? 'snoozed' : 'canceled';
                const updated: ProspectiveIntention = {
                  ...item,
                  status: nextStatus,
                  updatedAt: now,
                  ...(nextStatus === 'fulfilled' ? { fulfilledAt: now } : {}),
                  ...(nextStatus === 'snoozed' ? { snoozedUntil: now + (input.snoozeMinutes ?? 30) * 60_000 } : {}),
                };
                updatedOut = updated;
                return updated;
              });
              return {
                ...prev,
                intuition: withIntuitionRecount({
                  ...prev.intuition,
                  intentions: nextIntentions,
                }),
              };
            });
            setLastAction(`处理前瞻提醒 ${input.id} -> ${input.action}`);
            return updatedOut;
          }}
          onDeleteProspectiveIntention={async (id) => {
            if (initial.failActions) throw new Error('模拟连接中断：删除前瞻记录失败');
            setModel((prev) => ({
              ...prev,
              intuition: withIntuitionRecount({
                ...prev.intuition,
                intentions: prev.intuition.intentions.filter((i) => i.id !== id),
              }),
            }));
            setLastAction(`删除前瞻记录 ${id}`);
          }}
          onRecordFlashbackFeedback={async (sourceId, feedback) => {
            if (initial.failActions) throw new Error('模拟连接中断：记录闪回反馈失败');
            setModel((prev) => ({
              ...prev,
              intuition: {
                ...prev.intuition,
                mutedSourceCount:
                  feedback === 'muted' ? prev.intuition.mutedSourceCount + 1 : prev.intuition.mutedSourceCount,
                recentFlashbacks: prev.intuition.recentFlashbacks.map((f) =>
                  f.sourceId === sourceId ? { ...f, feedback } : f,
                ),
              },
            }));
            setLastAction(`闪回反馈 ${sourceId} -> ${feedback}`);
          }}
          onScanIntuitionFlashbacks={async (cueText) => {
            if (initial.failActions) throw new Error('模拟连接中断：直觉嗅探失败');
            const sourceMems = (overflowVaultRef.current ?? model.sleep.memories).map((m) => ({
              id: m.id,
              kind: m.kind,
              title: m.title,
              content: m.content,
              tags: m.tags,
              ...(m.topicKey ? { topicKey: m.topicKey } : {}),
              pinned: m.pinned,
              confidence: m.confidence,
              retention: m.retention,
              evidenceCount: m.evidenceCount,
              recallCount: m.recallCount,
              sourceSessionIds: m.sourceSessionIds,
              createdAt: m.createdAt,
              updatedAt: m.updatedAt,
            }));
            return previewMatcher.scan({
              cueText,
              memories: sourceMems,
              scars: [],
              minScore: 0.45,
              limit: 4,
            });
          }}
          onSetTomEnabled={async (enabled) => {
            if (initial.failActions) throw new Error('模拟连接中断：切换状态感知失败');
            setModel((prev) => ({
              ...prev,
              tom: {
                ...prev.tom,
                enabled,
                source: enabled ? (prev.tom.manualOverride ? 'manual_override' : 'inferred') : 'paused',
              },
            }));
            setLastAction(enabled ? '已开启搭档状态感知' : '已关闭搭档状态感知');
          }}
          onSetPartnerOverride={async (input) => {
            if (initial.failActions) throw new Error('模拟连接中断：搭档状态校准失败');
            let nextTom: TomPanelModel | undefined;
            setModel((prev) => {
              const target = input.state;
              if (target === null) {
                nextTom = {
                  ...prev.tom,
                  source: prev.tom.enabled ? 'inferred' : 'paused',
                  manualOverride: null,
                  confidence: 0.85,
                };
              } else {
                const durMs = (input.durationMinutes ?? 60) * 60_000;
                const guidance = buildTactGuidance(target, prev.tom.dimensions);
                nextTom = {
                  ...prev.tom,
                  state: target,
                  source: 'manual_override',
                  confidence: 1,
                  guidance,
                  manualOverride: {
                    state: target,
                    setAt: prev.tom.now,
                    expiresAt: prev.tom.now + durMs,
                  },
                  reasons: [`已手动锁定为「${PARTNER_STATE_LABELS[target]}」（剩余 60 分钟自动恢复推断）。`],
                  baseline: {
                    ...prev.tom.baseline,
                    calibrationCount: prev.tom.baseline.calibrationCount + 1,
                  },
                };
              }
              return { ...prev, tom: nextTom };
            });
            setLastAction(input.state ? `已校准搭档状态：${PARTNER_STATE_LABELS[input.state]}` : '已恢复自动状态感知');
            return nextTom;
          }}
          onResetTomBaseline={async () => {
            if (initial.failActions) throw new Error('模拟连接中断：重置基线失败');
            let nextTom: TomPanelModel | undefined;
            setModel((prev) => {
              nextTom = {
                ...prev.tom,
                source: prev.tom.enabled ? 'inferred' : 'paused',
                manualOverride: null,
                baseline: {
                  sampleCount: 0,
                  avgCadenceSec: 65,
                  avgPromptChars: 140,
                  avgSwitchesPer5m: 4,
                  calibrationCount: 0,
                },
              };
              return { ...prev, tom: nextTom };
            });
            setLastAction('已重置搭档交互基线');
            return nextTom;
          }}
          onDreamNow={async () => {
            if (initial.failActions) throw new Error('模拟连接中断：立即做梦联想失败');
            const baseDream = model.dream ?? makeDreamScenario('empty-dream', model.sleep.now);
            const newIns: DreamInsightViewItem = {
              id: `ins_manual_${Date.now()}`,
              kind: 'structural-analogy',
              status: 'open',
              title: '同构迁移：asi-plugin 的「流式传输背压与中断清理」决策可迁移至 orca-hub',
              summary: 'asi-plugin 已通过 AbortSignal 与帧节流避免订阅句柄泄漏，与 orca-hub 当前长连接流推送结构同构。',
              bridgeMechanism: '跨项目共享流式推送机制与 TypeScript 异步迭代器生命周期契约。',
              actionableHypothesis: '建议在 orca-hub 的流式生成器 finally 块中统一回收事件监听与节流定时器。',
              repoKeys: ['asi-plugin#1122', 'orca-hub#3344'],
              sourceRepos: [['~', 'work', 'asi-plugin'].join('/'), ['~', 'work', 'orca-hub'].join('/')],
              targetRepo: ['~', 'work', 'orca-hub'].join('/'),
              sourceMemoryIds: ['mem_stream_abort'],
              sourceSessionIds: ['sess_stream_1'],
              tags: ['stream-abort-lifecycle', 'typescript', 'cross-repo'],
              topicKey: 'dmn:stream-abort-lifecycle',
              pairSignature: `manual-${Date.now()}`,
              noveltyScore: 0.84,
              structuralSimilarity: 0.8,
              confidence: 0.89,
              createdAt: baseDream.now,
              updatedAt: baseDream.now,
            };
            const rec: DreamCycleRecord = {
              id: `drm_${Date.now()}`,
              at: baseDream.now,
              trigger: 'manual',
              reposScanned: Math.max(2, baseDream.drive.discoveredRepoCount),
              bridgesEvaluated: 1,
              insightsCreated: 1,
              insightsReinforced: 0,
              durationMs: 24,
              summary: '扫描 3 个仓库、评估 1 条远距桥接，新生成 1 条顿悟',
            };
            setModel((prev) => {
              const cur = prev.dream ?? baseDream;
              return {
                ...prev,
                dream: withDreamRecount({
                  ...cur,
                  drive: {
                    ...cur.drive,
                    satisfaction: 100,
                    urgency: 0,
                    zone: 'comfortable',
                    readyToDream: false,
                    candidateBridgeCount: 0,
                    lastDreamAt: cur.now,
                    summary: '已完成手动做梦联想，跨仓顿悟待审阅',
                  },
                  insights: [newIns, ...cur.insights],
                  recentDreams: [rec, ...cur.recentDreams],
                }),
              };
            });
            setLastAction('已完成立即做梦联想');
            return rec;
          }}
          onToggleAutoDreamPaused={async (paused) => {
            if (initial.failActions) throw new Error('模拟连接中断：暂停自动做梦失败');
            setModel((prev) => {
              const cur = prev.dream ?? makeDreamScenario('empty-dream', prev.sleep.now);
              return { ...prev, dream: { ...cur, autoDreamPaused: paused } };
            });
            setLastAction(paused ? '已暂停自动做梦' : '已恢复自动做梦');
          }}
          onAdoptDreamInsight={async (input) => {
            if (initial.failActions) throw new Error('模拟连接中断：采纳顿悟失败');
            const curDream = model.dream ?? makeDreamScenario('empty-dream', model.sleep.now);
            const target = curDream.insights.find((i) => i.id === input.insightId);
            if (!target) throw new Error('未找到顿悟记录');
            const memoryId = `mem_dmn_${Date.now()}`;
            const createdMem: MemoryViewItem = {
              id: memoryId,
              kind: target.kind === 'preventive-warning' ? 'pitfall' : 'decision',
              title: target.title,
              content: `${target.summary}\n同构机制：${target.bridgeMechanism}\n迁移行动：${target.actionableHypothesis}`,
              tags: [...new Set([...target.tags, 'dmn-insight'])],
              topicKey: target.topicKey,
              pinned: input.pinned ?? true,
              confidence: target.confidence,
              sourceSessionIds: target.sourceSessionIds,
              evidenceCount: 1,
              recallCount: 0,
              createdAt: model.sleep.now,
              updatedAt: model.sleep.now,
              retention: 1,
              fsrs: {
                stability: 20,
                difficulty: 3.2,
                elapsedDays: 0,
                scheduledDays: 20,
                learningSteps: 0,
                reps: 1,
                lapses: 0,
                state: 2,
                due: model.sleep.now + 20 * 86_400_000,
                lastReview: model.sleep.now,
              },
            };
            const updatedInsight: DreamInsightViewItem = {
              ...target,
              status: 'adopted',
              adoptedMemoryId: memoryId,
              updatedAt: curDream.now,
            };
            setModel((prev) => {
              const prevDream = prev.dream ?? curDream;
              const nextInsights = prevDream.insights.map((i) => (i.id === target.id ? updatedInsight : i));
              const nextSleep = overflowVaultRef.current
                ? (() => {
                    overflowVaultRef.current = [createdMem, ...overflowVaultRef.current];
                    return withSleepRecount(prev.sleep, overflowVaultRef.current);
                  })()
                : withSleepRecount({ ...prev.sleep, memories: [createdMem, ...prev.sleep.memories] });
              return {
                ...prev,
                sleep: nextSleep,
                dream: withDreamRecount({ ...prevDream, insights: nextInsights }),
              };
            });
            setLastAction(`采纳顿悟 ${target.id}`);
            return { insight: updatedInsight, memoryId };
          }}
          onPromoteDreamInsight={async (insightId) => {
            if (initial.failActions) throw new Error('模拟连接中断：转交技能草案失败');
            const curDream = model.dream ?? makeDreamScenario('empty-dream', model.sleep.now);
            const target = curDream.insights.find((i) => i.id === insightId);
            if (!target) throw new Error('未找到顿悟记录');
            const slug = toValidSkillSlug(`dmn-${target.topicKey.replace(/[:]/g, '-')}`, 'dmn-insight');
            const draftId = `draft_dmn_${Date.now()}`;
            const md = renderSkillMarkdown({
              name: slug,
              description: `${DREAM_INSIGHT_KIND_LABELS[target.kind]}：${target.title}`,
              license: 'MIT',
              body: `# ${target.title}\n\n${target.summary}\n\n1. ${target.actionableHypothesis}`,
            });
            const draft: SkillDraftViewItem = {
              id: draftId,
              name: slug,
              description: `${DREAM_INSIGHT_KIND_LABELS[target.kind]}：${target.title}`,
              markdown: md,
              scope: 'global',
              targetVersion: 1,
              isRevision: false,
              topicKey: target.topicKey,
              evidenceIds: [target.id],
              memoryCount: target.sourceMemoryIds.length,
              trajectoryCount: 0,
              evidenceSummary: `由跨项目顿悟 ${target.sourceRepos.join(' ↔ ')} 转化`,
              createdAt: model.growth.now,
              updatedAt: model.growth.now,
              trigger: 'manual',
            };
            const updatedInsight: DreamInsightViewItem = {
              ...target,
              status: 'promoted',
              promotedDraftId: draftId,
              updatedAt: curDream.now,
            };
            setModel((prev) => {
              const prevDream = prev.dream ?? curDream;
              return {
                ...prev,
                growth: withGrowthRecount({ ...prev.growth, drafts: [draft, ...prev.growth.drafts] }),
                dream: withDreamRecount({
                  ...prevDream,
                  insights: prevDream.insights.map((i) => (i.id === target.id ? updatedInsight : i)),
                }),
              };
            });
            setLastAction(`顿悟转草案 ${slug}`);
            return { insight: updatedInsight, draftId, skillName: slug };
          }}
          onDismissDreamInsight={async (insightId) => {
            if (initial.failActions) throw new Error('模拟连接中断：忽略顿悟失败');
            let out: DreamInsightViewItem | undefined;
            setModel((prev) => {
              const cur = prev.dream ?? makeDreamScenario('empty-dream', prev.sleep.now);
              const nextInsights = cur.insights.map((i) => {
                if (i.id !== insightId) return i;
                const d: DreamInsightViewItem = { ...i, status: 'dismissed', updatedAt: cur.now };
                out = d;
                return d;
              });
              return { ...prev, dream: withDreamRecount({ ...cur, insights: nextInsights }) };
            });
            setLastAction(`忽略顿悟 ${insightId}`);
            return out;
          }}
          onSearchDreamInsights={async (query, kind, status) => {
            const cur = model.dream ?? makeDreamScenario('empty-dream', model.sleep.now);
            const statuses = !status || status === 'all' ? undefined : [status];
            return searchDreamInsights(cur.insights, query, {
              ...(kind ? { kind } : {}),
              ...(statuses ? { statuses } : {}),
              limit: 100,
            });
          }}
        />
      </main>
    </>
  );
}
