import { useEffect, useState } from 'react';
import { GrowthPanel } from '../client/GrowthPanel.js';
import { GROWTH_SCENARIOS, type GrowthScenarioName, makeGrowthScenario } from '../client/mock-scenarios.js';
import { parseSkillMarkdown, renderSkillMarkdown, toValidSkillSlug } from '../shared/skill-spec.js';
import type {
  ArchivedSkillViewItem,
  GrowthPanelModel,
  GrowthSynthesisRecord,
  SkillDraftViewItem,
  SkillViewItem,
} from '../shared/types.js';

type Theme = 'light' | 'dark';

function readQuery(): { scenario: GrowthScenarioName; theme: Theme; failActions: boolean } {
  const q = new URLSearchParams(location.search);
  const s = q.get('scenario');
  const t = q.get('theme');
  return {
    scenario: (GROWTH_SCENARIOS as readonly string[]).includes(s ?? '') ? (s as GrowthScenarioName) : 'workshop-ready',
    theme: t === 'dark' ? 'dark' : 'light',
    failActions: q.get('failActions') === '1',
  };
}

function applyTheme(theme: Theme) {
  if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '');
  else document.body.removeAttribute('data-ds-dark-theme');
  document.documentElement.style.colorScheme = theme;
}

function withRecount(model: GrowthPanelModel): GrowthPanelModel {
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

export function App() {
  const initial = readQuery();
  const [scenario, setScenario] = useState<GrowthScenarioName>(initial.scenario);
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [model, setModel] = useState<GrowthPanelModel>(() => makeGrowthScenario(initial.scenario));
  const [lastAction, setLastAction] = useState('');

  useEffect(() => applyTheme(theme), [theme]);

  const switchScenario = (name: GrowthScenarioName) => {
    setScenario(name);
    setModel(makeGrowthScenario(name));
  };

  return (
    <>
      <nav className="demoBar" aria-label="预览工具栏">
        <label>
          场景
          <select value={scenario} onChange={(e) => switchScenario(e.target.value as GrowthScenarioName)}>
            {GROWTH_SCENARIOS.map((s) => (
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
        <GrowthPanel
          model={model}
          onSynthesizeNow={async () => {
            if (initial.failActions) throw new Error('模拟连接中断：立即提炼失败');
            const newMarkdown = renderSkillMarkdown({
              name: 'vitest-cordis-lifecycle',
              description: 'Verify Cordis plugin reverse-order startup and clean disposal in integration suites.',
              whenToUse: 'Use when writing multi-plugin Cordis integration tests.',
              license: 'MIT',
              body: '# Cordis Lifecycle Testing\n\n## Standard Procedure\n1. Test reverse plugin load order.\n2. Dispose every fork in finally.',
            });
            const newDraft: SkillDraftViewItem = {
              id: `draft_syn_${Date.now()}`,
              name: 'vitest-cordis-lifecycle',
              description: 'Verify Cordis plugin reverse-order startup and clean disposal in integration suites.',
              whenToUse: 'Use when writing multi-plugin Cordis integration tests.',
              markdown: newMarkdown,
              scope: 'global',
              targetVersion: 1,
              isRevision: false,
              topicKey: 'vitest-cordis',
              evidenceIds: ['mem_a', 'mem_b', 'mem_c'],
              memoryCount: 3,
              trajectoryCount: 2,
              evidenceSummary: '聚合 3 条高保留率记忆（含 2 条踩坑）与 2 条多步排障轨迹',
              createdAt: model.now,
              updatedAt: model.now,
              trigger: 'manual',
            };
            const rec: GrowthSynthesisRecord = {
              id: `growth_${Date.now()}`,
              at: model.now,
              trigger: 'manual',
              clustersInspected: 1,
              draftsCreated: 1,
              revisionsCreated: 0,
              durationMs: 19,
              summary: '提炼 1 份待审 SKILL.md 草案（新建 1 / 修订 0），等待人工批准启用',
            };
            setModel((prev) =>
              withRecount({
                ...prev,
                drive: {
                  ...prev.drive,
                  satisfaction: 100,
                  urgency: 0,
                  zone: 'comfortable',
                  readyToSynthesize: false,
                  readyClusters: 0,
                  lastSynthesisAt: prev.now,
                  summary: '已完成手动提炼，待人工审批草案',
                },
                drafts: [newDraft, ...prev.drafts],
                recentSyntheses: [rec, ...prev.recentSyntheses],
              }),
            );
            setLastAction('已完成立即提炼技能');
            return rec;
          }}
          onToggleAutoGrowthPaused={async (paused) => {
            if (initial.failActions) throw new Error('模拟连接中断：暂停开关失败');
            setModel((prev) => ({ ...prev, autoGrowthPaused: paused }));
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
              createdAt: model.now,
              updatedAt: model.now,
              trigger: 'manual',
            };
            setModel((prev) => withRecount({ ...prev, drafts: [created, ...prev.drafts] }));
            setLastAction(`新建草案 ${slug}`);
            return created;
          }}
          onUpdateDraft={async (draftId, patch) => {
            let out: SkillDraftViewItem | undefined;
            setModel((prev) => {
              const nextDrafts = prev.drafts.map((d) => {
                if (d.id !== draftId) return d;
                const parsed = parseSkillMarkdown(patch.markdown);
                const nextScope = patch.scope ?? d.scope;
                const nextWs = nextScope === 'workspace' ? (patch.workspacePath ?? d.workspacePath) : undefined;
                const wsDisp = prev.knownWorkspaces.find((w) => w.path === nextWs)?.display ?? nextWs;
                const updated: SkillDraftViewItem = {
                  ...d,
                  name: parsed.document?.name ?? d.name,
                  description: parsed.document?.description ?? d.description,
                  markdown: patch.markdown,
                  scope: nextScope,
                  ...(nextWs ? { workspacePath: nextWs, workspaceDisplay: wsDisp } : {}),
                  updatedAt: prev.now,
                };
                if (!nextWs) {
                  delete updated.workspacePath;
                  delete updated.workspaceDisplay;
                }
                out = updated;
                return updated;
              });
              return withRecount({ ...prev, drafts: nextDrafts });
            });
            setLastAction(`更新草案 ${draftId}`);
            return out;
          }}
          onApproveDraft={async (draftId) => {
            if (initial.failActions) throw new Error('模拟连接中断：批准草案失败');
            let approvedOut: SkillViewItem | undefined;
            setModel((prev) => {
              const draft = prev.drafts.find((d) => d.id === draftId);
              if (!draft) return prev;
              const existing = prev.skills.find((s) => s.name === draft.name);
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
                approvedAt: existing?.approvedAt ?? prev.now,
                updatedAt: prev.now,
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
              const restSkills = prev.skills.filter((s) => s.name !== draft.name);
              return withRecount({
                ...prev,
                drafts: prev.drafts.filter((d) => d.id !== draftId),
                skills: [nextSkill, ...restSkills],
              });
            });
            setLastAction(`已批准 ${draftId}`);
            return approvedOut;
          }}
          onRejectDraft={async (draftId) => {
            setModel((prev) => withRecount({ ...prev, drafts: prev.drafts.filter((d) => d.id !== draftId) }));
            setLastAction(`已驳回 ${draftId}`);
          }}
          onUpdateSkill={async (name, patch) => {
            let out: SkillViewItem | undefined;
            setModel((prev) => {
              const nextSkills = prev.skills.map((s) => {
                if (s.name !== name) return s;
                const parsed = parseSkillMarkdown(patch.markdown);
                const updated: SkillViewItem = {
                  ...s,
                  description: parsed.document?.description ?? s.description,
                  markdown: patch.markdown,
                  updatedAt: prev.now,
                };
                out = updated;
                return updated;
              });
              return withRecount({ ...prev, skills: nextSkills });
            });
            setLastAction(`编辑技能 ${name}`);
            return out;
          }}
          onSetSkillScope={async (name, input) => {
            let out: SkillViewItem | undefined;
            setModel((prev) => {
              const nextSkills = prev.skills.map((s) => {
                if (s.name !== name) return s;
                const wsDisp =
                  prev.knownWorkspaces.find((w) => w.path === input.workspacePath)?.display ?? input.workspacePath;
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
              return withRecount({ ...prev, skills: nextSkills });
            });
            setLastAction(`切换作用域 ${name}`);
            return out;
          }}
          onSetSkillEnabled={async (name, enabled) => {
            let out: SkillViewItem | undefined;
            setModel((prev) => {
              const nextSkills = prev.skills.map((s) => {
                if (s.name !== name) return s;
                const updated: SkillViewItem = {
                  ...s,
                  status: enabled ? 'active' : 'disabled',
                  stale: enabled ? s.stale : false,
                };
                out = updated;
                return updated;
              });
              return withRecount({ ...prev, skills: nextSkills });
            });
            setLastAction(`${enabled ? '启用' : '停用'} ${name}`);
            return out;
          }}
          onArchiveSkill={async (name) => {
            if (initial.failActions) throw new Error('模拟连接中断：归档技能失败');
            let out: ArchivedSkillViewItem | undefined;
            setModel((prev) => {
              const found = prev.skills.find((s) => s.name === name);
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
                archivedAt: prev.now,
                invocationCount: found.invocationCount,
                lastInvokedAt: found.lastInvokedAt,
                turnCompletionRate: found.turnCompletionRate,
              };
              out = arch;
              return withRecount({
                ...prev,
                skills: prev.skills.filter((s) => s.name !== name),
                archivedSkills: [arch, ...prev.archivedSkills],
              });
            });
            setLastAction(`归档技能 ${name}`);
            return out;
          }}
          onRestoreSkill={async (name) => {
            let out: SkillViewItem | undefined;
            setModel((prev) => {
              const arch = prev.archivedSkills.find((a) => a.name === name);
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
                approvedAt: prev.now,
                updatedAt: prev.now,
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
              return withRecount({
                ...prev,
                skills: [restored, ...prev.skills],
                archivedSkills: prev.archivedSkills.filter((a) => a.name !== name),
              });
            });
            setLastAction(`恢复技能 ${name}`);
            return out;
          }}
          onDeleteArchivedSkill={async (name) => {
            setModel((prev) =>
              withRecount({ ...prev, archivedSkills: prev.archivedSkills.filter((a) => a.name !== name) }),
            );
            setLastAction(`删除归档 ${name}`);
          }}
          onExportSkillToWorkspace={async (name, ws) => {
            const disp = model.knownWorkspaces.find((w) => w.path === ws)?.display ?? ws;
            const displayPath = `${disp}/.agents/skills/${name}/SKILL.md`;
            setModel((prev) => ({
              ...prev,
              skills: prev.skills.map((s) =>
                s.name === name ? { ...s, exportedWorkspaces: [...new Set([disp, ...s.exportedWorkspaces])] } : s,
              ),
            }));
            setLastAction(`导出 ${name} -> ${displayPath}`);
            return {
              name,
              exportedPath: `${ws}/.agents/skills/${name}/SKILL.md`,
              displayPath,
              at: model.now,
            };
          }}
        />
      </main>
    </>
  );
}
