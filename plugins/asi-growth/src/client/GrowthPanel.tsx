import type { NeedZone } from '@asi/sense-types';
import { type FormEvent, useMemo, useState } from 'react';
import { computeLineDiff } from '../shared/diff.js';
import { parseSkillMarkdown } from '../shared/skill-spec.js';
import type {
  ArchivedSkillViewItem,
  GrowthPanelModel,
  GrowthSynthesisRecord,
  SkillCreateDraftInput,
  SkillDraftViewItem,
  SkillExportResult,
  SkillScope,
  SkillScopeUpdateInput,
  SkillTabView,
  SkillUpdateMarkdownInput,
  SkillViewItem,
} from '../shared/types.js';
import css from './growth-panel.module.css';

export interface GrowthPanelActions {
  onSynthesizeNow: () => Promise<GrowthSynthesisRecord | undefined>;
  onToggleAutoGrowthPaused: (paused: boolean) => Promise<void>;
  onCreateManualDraft: (input: SkillCreateDraftInput) => Promise<SkillDraftViewItem | undefined>;
  onUpdateDraft: (draftId: string, patch: SkillUpdateMarkdownInput) => Promise<SkillDraftViewItem | undefined>;
  onApproveDraft: (draftId: string) => Promise<SkillViewItem | undefined>;
  onRejectDraft: (draftId: string) => Promise<void>;
  onUpdateSkill: (name: string, patch: SkillUpdateMarkdownInput) => Promise<SkillViewItem | undefined>;
  onSetSkillScope: (name: string, input: SkillScopeUpdateInput) => Promise<SkillViewItem | undefined>;
  onSetSkillEnabled: (name: string, enabled: boolean) => Promise<SkillViewItem | undefined>;
  onArchiveSkill: (name: string) => Promise<ArchivedSkillViewItem | undefined>;
  onRestoreSkill: (name: string) => Promise<SkillViewItem | undefined>;
  onDeleteArchivedSkill: (name: string) => Promise<void>;
  onExportSkillToWorkspace: (name: string, workspacePath: string) => Promise<SkillExportResult | undefined>;
}

export interface GrowthPanelProps extends GrowthPanelActions {
  model: GrowthPanelModel;
}

const ZONE_WORD: Record<NeedZone, string> = {
  comfortable: '舒适',
  uncomfortable: '不适',
  critical: '危急',
};

function ShieldIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.6 2.8 3.8v4.1c0 3.2 2.2 5.9 5.2 6.6 3-0.7 5.2-3.4 5.2-6.6V3.8L8 1.6Z"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function formatRelativeAgo(targetAt: number | null, now: number): string {
  if (targetAt === null || !Number.isFinite(targetAt)) return '尚未执行';
  const diffMs = Math.max(0, now - targetAt);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

function encodeScopeSelectValue(scope: SkillScope, workspacePath?: string): string {
  return scope === 'workspace' && workspacePath ? `ws:${workspacePath}` : 'global';
}

export function GrowthPanel(props: GrowthPanelProps) {
  const { model } = props;
  const [tab, setTab] = useState<SkillTabView>(() => (model.draftCount > 0 ? 'drafts' : 'active'));
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createWhen, setCreateWhen] = useState('');
  const [createScope, setCreateScope] = useState<SkillScope>('global');
  const [createWorkspace, setCreateWorkspace] = useState(() => model.knownWorkspaces[0]?.path ?? '');
  const [createBody, setCreateBody] = useState('');

  const [openPreviewId, setOpenPreviewId] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editMarkdown, setEditMarkdown] = useState('');
  const [openDiffDraftId, setOpenDiffDraftId] = useState<string | null>(null);
  const [exportTargetBySkill, setExportTargetBySkill] = useState<Record<string, string>>({});

  const [busySynthesize, setBusySynthesize] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [guardrailsOpen, setGuardrailsOpen] = useState(false);

  const normQuery = query.trim().toLowerCase();

  const filteredDrafts = useMemo(() => {
    if (!normQuery) return model.drafts;
    return model.drafts.filter(
      (d) =>
        d.name.toLowerCase().includes(normQuery) ||
        d.description.toLowerCase().includes(normQuery) ||
        d.markdown.toLowerCase().includes(normQuery),
    );
  }, [model.drafts, normQuery]);

  const filteredSkills = useMemo(() => {
    if (!normQuery) return model.skills;
    return model.skills.filter(
      (s) =>
        s.name.toLowerCase().includes(normQuery) ||
        s.description.toLowerCase().includes(normQuery) ||
        s.markdown.toLowerCase().includes(normQuery),
    );
  }, [model.skills, normQuery]);

  const filteredArchived = useMemo(() => {
    if (!normQuery) return model.archivedSkills;
    return model.archivedSkills.filter(
      (a) =>
        a.name.toLowerCase().includes(normQuery) ||
        a.description.toLowerCase().includes(normQuery) ||
        a.markdown.toLowerCase().includes(normQuery),
    );
  }, [model.archivedSkills, normQuery]);

  const editValidation = useMemo(() => {
    if (!editingKey) return null;
    return parseSkillMarkdown(editMarkdown);
  }, [editingKey, editMarkdown]);

  const handleSynthesizeNow = async () => {
    if (busySynthesize || model.synthesizing) return;
    setBusySynthesize(true);
    setFeedback(null);
    try {
      const rec = await props.onSynthesizeNow();
      setFeedback(rec?.summary || '已完成技能提炼检查。');
      if (rec && rec.draftsCreated + rec.revisionsCreated > 0) {
        setTab('drafts');
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '技能提炼失败');
    } finally {
      setBusySynthesize(false);
    }
  };

  const handleTogglePaused = async (paused: boolean) => {
    try {
      await props.onToggleAutoGrowthPaused(paused);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '更新自动提炼开关失败');
    }
  };

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!createName.trim() || !createDesc.trim() || !createBody.trim()) return;
    try {
      const wsPath = createScope === 'workspace' ? createWorkspace.trim() || model.knownWorkspaces[0]?.path : undefined;
      const created = await props.onCreateManualDraft({
        name: createName.trim(),
        description: createDesc.trim(),
        ...(createWhen.trim() ? { whenToUse: createWhen.trim() } : {}),
        scope: createScope,
        ...(wsPath ? { workspacePath: wsPath } : {}),
        body: createBody.trim(),
      });
      setCreateName('');
      setCreateDesc('');
      setCreateWhen('');
      setCreateBody('');
      setCreating(false);
      setTab('drafts');
      setFeedback(`已创建待审技能草案 ${created?.name ?? ''}，请审阅后点击批准启用。`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '创建技能草案失败');
    }
  };

  const beginEditMarkdown = (key: string, markdown: string) => {
    setEditingKey(key);
    setEditMarkdown(markdown);
    setOpenPreviewId(null);
  };

  const handleSaveDraftEdit = async (e: FormEvent, draftId: string) => {
    e.preventDefault();
    const check = parseSkillMarkdown(editMarkdown);
    if (!check.valid) {
      setFeedback(`SKILL.md 校验未通过：${check.errors[0] ?? '格式错误'}`);
      return;
    }
    try {
      await props.onUpdateDraft(draftId, { markdown: editMarkdown });
      setEditingKey(null);
      setFeedback('已保存草案 SKILL.md 修改。');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '保存草案修改失败');
    }
  };

  const handleSaveSkillEdit = async (e: FormEvent, name: string) => {
    e.preventDefault();
    const check = parseSkillMarkdown(editMarkdown);
    if (!check.valid) {
      setFeedback(`SKILL.md 校验未通过：${check.errors[0] ?? '格式错误'}`);
      return;
    }
    try {
      await props.onUpdateSkill(name, { markdown: editMarkdown });
      setEditingKey(null);
      setFeedback(`已保存并热重载技能 ${name}。`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '保存技能修改失败');
    }
  };

  const handleDraftScopeChange = async (draft: SkillDraftViewItem, selectValue: string) => {
    try {
      if (selectValue === 'global') {
        await props.onUpdateDraft(draft.id, { markdown: draft.markdown, scope: 'global' });
        setFeedback(`已将草案 ${draft.name} 切为全局作用域。`);
      } else if (selectValue.startsWith('ws:')) {
        const wsPath = selectValue.slice(3);
        await props.onUpdateDraft(draft.id, { markdown: draft.markdown, scope: 'workspace', workspacePath: wsPath });
        setFeedback(`已将草案 ${draft.name} 绑定至目标工作区。`);
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '切换草案作用域失败');
    }
  };

  const handleSkillScopeChange = async (skill: SkillViewItem, selectValue: string) => {
    try {
      if (selectValue === 'global') {
        await props.onSetSkillScope(skill.name, { scope: 'global' });
        setFeedback(`已将技能 ${skill.name} 切为全局生效并热刷新 ctx.skills。`);
      } else if (selectValue.startsWith('ws:')) {
        const wsPath = selectValue.slice(3);
        await props.onSetSkillScope(skill.name, { scope: 'workspace', workspacePath: wsPath });
        setFeedback(`已将技能 ${skill.name} 限定至工作区生效并热刷新 ctx.skills。`);
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '切换技能作用域失败');
    }
  };

  const handleApproveDraft = async (draft: SkillDraftViewItem) => {
    try {
      const approved = await props.onApproveDraft(draft.id);
      setFeedback(
        `已批准启用 ${approved?.name ?? draft.name} (v${approved?.version ?? draft.targetVersion}) · 已热挂载至 ctx.skills。`,
      );
      setTab('active');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '批准草案失败');
    }
  };

  const handleRejectDraft = async (draft: SkillDraftViewItem) => {
    try {
      await props.onRejectDraft(draft.id);
      setFeedback(`已驳回草案 ${draft.name}。`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '驳回草案失败');
    }
  };

  const handleToggleSkillEnabled = async (skill: SkillViewItem) => {
    const nextEnabled = skill.status !== 'active';
    try {
      await props.onSetSkillEnabled(skill.name, nextEnabled);
      setFeedback(
        nextEnabled
          ? `已启用技能 ${skill.name} 并挂载至 ctx.skills。`
          : `已停用技能 ${skill.name}（从 ctx.skills 卸载）。`,
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '切换技能启用状态失败');
    }
  };

  const handleArchiveSkill = async (name: string) => {
    try {
      await props.onArchiveSkill(name);
      setFeedback(`已归档技能 ${name}（已从 ctx.skills 卸载，可在已归档页一键恢复）。`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '归档技能失败');
    }
  };

  const handleRestoreSkill = async (name: string) => {
    try {
      await props.onRestoreSkill(name);
      setFeedback(`已恢复启用技能 ${name} 并重新挂载至 ctx.skills。`);
      setTab('active');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '恢复技能失败');
    }
  };

  const handleDeleteArchived = async (name: string) => {
    try {
      await props.onDeleteArchivedSkill(name);
      setFeedback(`已删除归档技能 ${name}。`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '删除归档失败');
    }
  };

  const handleExportSkill = async (skill: SkillViewItem) => {
    const selectedWs = exportTargetBySkill[skill.name] ?? skill.workspacePath ?? model.knownWorkspaces[0]?.path ?? '';
    if (!selectedWs.trim()) {
      setFeedback('请先选择或输入要导出的目标工作区路径。');
      return;
    }
    try {
      const res = await props.onExportSkillToWorkspace(skill.name, selectedWs.trim());
      setFeedback(`已导出至 ${res?.displayPath ?? '.agents/skills'}。`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '导出技能至工作区失败');
    }
  };

  const { drive } = model;
  const sat = Math.max(0, Math.min(100, Math.round(drive.satisfaction)));
  const urg = Math.max(0, Math.min(100, Math.round(drive.urgency)));
  const idleMinutes = Math.floor(drive.idleDurationMs / 60_000);
  const quietStatusText = drive.screenLocked
    ? '已锁屏（深静默就绪）'
    : drive.deepQuietWindow
      ? `空闲 ${idleMinutes} 分钟（深静默就绪）`
      : `空闲 ${idleMinutes}/20 分钟`;

  const buildWorkspaceOptions = (extraPath?: string, extraDisplay?: string) => {
    const map = new Map<string, string>();
    for (const ws of model.knownWorkspaces) {
      map.set(ws.path, ws.display);
    }
    if (extraPath && !map.has(extraPath)) {
      map.set(extraPath, extraDisplay ?? extraPath);
    }
    return [...map.entries()];
  };

  return (
    <div className={`${css.gwPanel} ${model.stale ? css.gwStalePanel : ''}`} data-panel data-testid="asi-growth-panel">
      <header className={css.gwHeader}>
        <h1 className={css.gwTitle}>技能工坊</h1>
        <span className={css.gwPrivacyBadge} title="纯文本 SKILL.md 经脱敏存储于本机，须人工批准后才挂载">
          <ShieldIcon />
          人工审批
        </span>
        {(model.synthesizing || busySynthesize) && (
          <span className={`${css.gwStatusTag} ${css.gwActiveTag}`}>提炼中</span>
        )}
        {(drive.suppressed || drive.lowerTierBlocked) && (
          <span className={`${css.gwStatusTag} ${css.gwWarnTag}`}>已挂起</span>
        )}
        {model.autoGrowthPaused && <span className={`${css.gwStatusTag} ${css.gwWarnTag}`}>自动提炼已暂停</span>}
        {model.staleCount > 0 && (
          <span className={`${css.gwStatusTag} ${css.gwWarnTag}`}>待代谢 {model.staleCount}</span>
        )}
      </header>

      <details open className={css.gwSection}>
        <summary>技能自进化与静默门控</summary>
        <div className={css.gwSectionBody}>
          <div
            className={css.gwDriveCard}
            data-zone={drive.zone}
            data-suppressed={drive.suppressed || drive.lowerTierBlocked ? 'true' : 'false'}
          >
            <div className={css.gwCardHead}>
              <span className={css.gwBadgeRow}>
                <span className={css.gwTierBadge}>L4</span>
                <strong>技能提炼与自进化</strong>
                <span className={css.gwZoneBadge} data-zone={drive.zone}>
                  {ZONE_WORD[drive.zone]}
                </span>
              </span>
              <span className={css.gwMetaText}>
                满足 {sat}% · 紧迫 {urg}%
              </span>
            </div>
            <div className={css.gwMeterTrack} aria-hidden="true">
              <i className={css.gwMeterFill} data-zone={drive.zone} style={{ width: `${sat}%` }} />
            </div>
            <p className={css.gwMetaText}>{drive.summary}</p>
            <div className={css.gwMetricsGrid}>
              <span className={css.gwMetricItem}>
                达标簇：
                <strong>
                  {drive.readyClusters} 个（记忆 {drive.highRetentionMemoryCount} / 轨迹{' '}
                  {drive.recurringTrajectoryCount}）
                </strong>
              </span>
              <span className={css.gwMetricItem}>
                深静默窗：<strong>{quietStatusText}</strong>
              </span>
              <span className={css.gwMetricItem}>
                自动配额：
                <strong>
                  {drive.autoDraftsToday}/{drive.dailyAutoQuota} 次/日
                </strong>
              </span>
              <span className={css.gwMetricItem}>
                上次提炼：<strong>{formatRelativeAgo(drive.lastSynthesisAt, model.now)}</strong>
              </span>
            </div>
          </div>

          <div className={css.gwActionRow}>
            <button
              type="button"
              className={css.gwPrimaryBtn}
              data-testid="synthesize-now-btn"
              disabled={busySynthesize || model.synthesizing}
              onClick={() => void handleSynthesizeNow()}
            >
              {busySynthesize || model.synthesizing ? '技能提炼中…' : '立即提炼技能'}
            </button>

            <label className={css.gwToggleRow}>
              <input
                type="checkbox"
                data-testid="auto-growth-pause-toggle"
                checked={model.autoGrowthPaused}
                onChange={(e) => void handleTogglePaused(e.currentTarget.checked)}
              />
              暂停自动技能提炼
            </label>
          </div>

          {feedback && (
            <div role="status" className={css.gwFeedbackBanner} data-testid="growth-feedback">
              {feedback}
            </div>
          )}

          {model.recentSyntheses.length > 0 && (
            <ul className={css.gwJournalList} aria-label="最近技能工坊动态">
              {model.recentSyntheses.slice(0, 2).map((rec) => (
                <li key={rec.id}>
                  [{rec.trigger === 'manual' ? '手动' : '自动'} · {formatRelativeAgo(rec.at, model.now)}] {rec.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <details open className={css.gwSection}>
        <summary>
          技能工坊管理（草案 {model.draftCount} / 已启用 {model.activeCount}）
        </summary>
        <div className={css.gwSectionBody}>
          <div className={css.gwSearchBar}>
            <input
              type="search"
              className={css.gwSearchInput}
              aria-label="搜索技能与草案"
              data-testid="skill-search-input"
              placeholder="搜索技能名称、描述或 SKILL.md 内容…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="清空技能搜索词">
                清空
              </button>
            )}
          </div>

          <fieldset className={css.gwTabRow}>
            <legend className={css.gwSrOnly}>技能视图切换</legend>
            <button
              type="button"
              data-testid="tab-drafts"
              className={`${css.gwTabPill} ${tab === 'drafts' ? css.gwTabPillActive : ''}`}
              aria-pressed={tab === 'drafts'}
              onClick={() => setTab('drafts')}
            >
              待审草案 ({model.draftCount})
            </button>
            <button
              type="button"
              data-testid="tab-active"
              className={`${css.gwTabPill} ${tab === 'active' ? css.gwTabPillActive : ''}`}
              aria-pressed={tab === 'active'}
              onClick={() => setTab('active')}
            >
              已启用 ({model.skills.length})
            </button>
            <button
              type="button"
              data-testid="tab-archived"
              className={`${css.gwTabPill} ${tab === 'archived' ? css.gwTabPillActive : ''}`}
              aria-pressed={tab === 'archived'}
              onClick={() => setTab('archived')}
            >
              已归档 ({model.archivedCount})
            </button>
          </fieldset>

          <div className={css.gwActionRow}>
            <button
              type="button"
              data-testid="new-skill-btn"
              onClick={() => {
                setCreating((prev) => !prev);
                setEditingKey(null);
              }}
            >
              {creating ? '收起新建表单' : '+ 手动新建技能'}
            </button>
          </div>

          {creating && (
            <form
              className={css.gwEditorCard}
              onSubmit={(e) => void handleCreateSubmit(e)}
              data-testid="create-skill-form"
            >
              <label className={css.gwFieldLabel}>
                技能名称（kebab-case）
                <input
                  type="text"
                  className={css.gwFieldInput}
                  required
                  value={createName}
                  onChange={(e) => setCreateName(e.currentTarget.value)}
                  placeholder="例如 playwright-contrast-check"
                />
              </label>
              <label className={css.gwFieldLabel}>
                功能与触发描述（10–1024 字）
                <input
                  type="text"
                  className={css.gwFieldInput}
                  required
                  value={createDesc}
                  onChange={(e) => setCreateDesc(e.currentTarget.value)}
                  placeholder="说明技能做什么以及何时自动触发"
                />
              </label>
              <label className={css.gwFieldLabel}>
                适用时机（when-to-use，可选）
                <input
                  type="text"
                  className={css.gwFieldInput}
                  value={createWhen}
                  onChange={(e) => setCreateWhen(e.currentTarget.value)}
                  placeholder="例如修改侧栏样式或无障碍测试时"
                />
              </label>
              <label className={css.gwFieldLabel}>
                生效作用域
                <select
                  className={css.gwFieldSelect}
                  value={createScope}
                  onChange={(e) => setCreateScope(e.currentTarget.value as SkillScope)}
                >
                  <option value="global">全局（所有工作区可用）</option>
                  <option value="workspace">仅指定工作区（cwd 隔离）</option>
                </select>
              </label>
              {createScope === 'workspace' && (
                <label className={css.gwFieldLabel}>
                  目标工作区路径
                  <input
                    type="text"
                    className={css.gwFieldInput}
                    required
                    value={createWorkspace}
                    onChange={(e) => setCreateWorkspace(e.currentTarget.value)}
                    placeholder="工作区绝对路径"
                  />
                </label>
              )}
              <label className={css.gwFieldLabel}>
                指令正文（Markdown）
                <textarea
                  className={css.gwFieldTextarea}
                  required
                  value={createBody}
                  onChange={(e) => setCreateBody(e.currentTarget.value)}
                  placeholder={'# 技能标题\n\n## 标准步骤\n1. 先跑复现测试…'}
                />
              </label>
              <div className={css.gwActionRow}>
                <button type="submit" className={css.gwPrimaryBtn}>
                  生成待审草案
                </button>
                <button type="button" onClick={() => setCreating(false)}>
                  取消
                </button>
              </div>
            </form>
          )}

          {tab === 'drafts' &&
            (filteredDrafts.length === 0 ? (
              <p className={css.gwEmptyHint} data-testid="empty-drafts-hint">
                {normQuery
                  ? '没有匹配的待审草案。'
                  : '当前无待审技能草案；积累足够踩坑记忆与排障轨迹后将在深静默期自动起草。'}
              </p>
            ) : (
              filteredDrafts.map((draft) => {
                const editKey = `draft:${draft.id}`;
                const isEditing = editingKey === editKey;
                const isPreviewing = openPreviewId === editKey;
                const isDiffOpen = openDiffDraftId === draft.id;
                const wsOptions = buildWorkspaceOptions(draft.workspacePath, draft.workspaceDisplay);
                const diffLines =
                  isDiffOpen && draft.baseMarkdown ? computeLineDiff(draft.baseMarkdown, draft.markdown) : [];

                return (
                  <article key={draft.id} className={css.gwSkillCard} data-draft-id={draft.id}>
                    <div className={css.gwCardHead}>
                      <span className={css.gwBadgeRow}>
                        <span className={draft.isRevision ? css.gwRevisionBadge : css.gwChipBadge}>
                          {draft.isRevision
                            ? `增量修订 v${draft.baseVersion ?? 1} → v${draft.targetVersion}`
                            : `新草案 v${draft.targetVersion}`}
                        </span>
                        <span className={css.gwChipBadge}>
                          {draft.scope === 'workspace'
                            ? `工作区 · ${draft.workspaceDisplay ?? '指定目录'}`
                            : '全局作用域'}
                        </span>
                      </span>
                      <span className={css.gwMetaText}>{formatRelativeAgo(draft.updatedAt, model.now)}</span>
                    </div>

                    <h2 className={css.gwSkillTitle}>{draft.name}</h2>
                    <p className={css.gwSkillDesc}>{draft.description}</p>
                    <p className={css.gwMetaText}>{draft.evidenceSummary}</p>

                    <label className={css.gwFieldLabel}>
                      生效作用域切换
                      <select
                        className={css.gwFieldSelect}
                        aria-label={`生效作用域切换 ${draft.name}`}
                        value={encodeScopeSelectValue(draft.scope, draft.workspacePath)}
                        onChange={(e) => void handleDraftScopeChange(draft, e.currentTarget.value)}
                      >
                        <option value="global">全局（所有工作区生效）</option>
                        {wsOptions.map(([wsPath, wsDisplay]) => (
                          <option key={wsPath} value={`ws:${wsPath}`}>
                            工作区：{wsDisplay}
                          </option>
                        ))}
                      </select>
                    </label>

                    {isDiffOpen && draft.baseMarkdown && (
                      <section className={css.gwDiffBox} data-testid="skill-diff-view" aria-label="版本差异对比">
                        {diffLines.map((dl) => (
                          <div
                            key={`${dl.kind}-${dl.oldLine ?? 0}-${dl.newLine ?? 0}`}
                            className={`${css.gwDiffLine} ${
                              dl.kind === 'add' ? css.gwDiffAdd : dl.kind === 'remove' ? css.gwDiffRemove : ''
                            }`}
                          >
                            {dl.kind === 'add' ? '+ ' : dl.kind === 'remove' ? '- ' : '  '}
                            {dl.text}
                          </div>
                        ))}
                      </section>
                    )}

                    {isPreviewing && !isEditing && (
                      <pre className={css.gwCodePreview} data-testid="skill-markdown-preview">
                        {draft.markdown}
                      </pre>
                    )}

                    {isEditing && (
                      <form onSubmit={(e) => void handleSaveDraftEdit(e, draft.id)} data-testid="edit-draft-form">
                        <label className={css.gwFieldLabel}>
                          编辑 SKILL.md（自动校验 agentskills 规范）
                          <textarea
                            className={css.gwFieldTextarea}
                            value={editMarkdown}
                            onChange={(e) => setEditMarkdown(e.currentTarget.value)}
                          />
                        </label>
                        {editValidation && !editValidation.valid && (
                          <p className={css.gwMetaText}>校验提示：{editValidation.errors[0]}</p>
                        )}
                        <div className={css.gwActionRow}>
                          <button type="submit" className={css.gwPrimaryBtn}>
                            保存草案修改
                          </button>
                          <button type="button" onClick={() => setEditingKey(null)}>
                            取消
                          </button>
                        </div>
                      </form>
                    )}

                    <div className={css.gwActionRow}>
                      <button
                        type="button"
                        className={css.gwPrimaryBtn}
                        aria-label={`批准启用 ${draft.name}`}
                        onClick={() => void handleApproveDraft(draft)}
                      >
                        批准启用
                      </button>
                      <button
                        type="button"
                        aria-label={`驳回草案 ${draft.name}`}
                        onClick={() => void handleRejectDraft(draft)}
                      >
                        驳回草案
                      </button>
                      {draft.isRevision && draft.baseMarkdown && (
                        <button
                          type="button"
                          aria-label={`${isDiffOpen ? '收起差异' : `查看 v${draft.baseVersion ?? 1} → v${draft.targetVersion} 差异`} ${draft.name}`}
                          onClick={() => setOpenDiffDraftId(isDiffOpen ? null : draft.id)}
                        >
                          {isDiffOpen ? '收起差异' : `查看 v${draft.baseVersion ?? 1} → v${draft.targetVersion} 差异`}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`${isPreviewing ? '收起预览' : '预览 SKILL.md'} ${draft.name}`}
                        onClick={() => {
                          setEditingKey(null);
                          setOpenPreviewId(isPreviewing ? null : editKey);
                        }}
                      >
                        {isPreviewing ? '收起预览' : '预览 SKILL.md'}
                      </button>
                      <button
                        type="button"
                        aria-label={`编辑 SKILL.md ${draft.name}`}
                        onClick={() => beginEditMarkdown(editKey, draft.markdown)}
                      >
                        编辑 SKILL.md
                      </button>
                    </div>
                  </article>
                );
              })
            ))}

          {tab === 'active' &&
            (filteredSkills.length === 0 ? (
              <p className={css.gwEmptyHint} data-testid="empty-skills-hint">
                {normQuery ? '没有匹配的已安装技能。' : '当前尚无已启用技能；可在待审草案中一键批准启用。'}
              </p>
            ) : (
              filteredSkills.map((skill) => {
                const editKey = `skill:${skill.name}`;
                const isEditing = editingKey === editKey;
                const isPreviewing = openPreviewId === editKey;
                const wsOptions = buildWorkspaceOptions(skill.workspacePath, skill.workspaceDisplay);
                const selectedExportWs =
                  exportTargetBySkill[skill.name] ?? skill.workspacePath ?? wsOptions[0]?.[0] ?? '';
                const completionText =
                  skill.turnCompletionRate !== null
                    ? `完成率 ${Math.round(skill.turnCompletionRate * 100)}%`
                    : '尚无回合样本';

                return (
                  <article
                    key={skill.name}
                    className={css.gwSkillCard}
                    data-skill-name={skill.name}
                    data-skill-status={skill.status}
                    data-stale={skill.stale ? 'true' : 'false'}
                  >
                    <div className={css.gwCardHead}>
                      <span className={css.gwBadgeRow}>
                        <span className={css.gwChipBadge}>v{skill.version}</span>
                        <span
                          className={css.gwZoneBadge}
                          data-zone={skill.status === 'active' ? 'comfortable' : 'uncomfortable'}
                        >
                          {skill.status === 'active' ? '已启用 · 热挂载' : '已停用'}
                        </span>
                        <span className={css.gwChipBadge}>
                          {skill.scope === 'workspace'
                            ? `工作区 · ${skill.workspaceDisplay ?? '指定目录'}`
                            : '全局作用域'}
                        </span>
                        {skill.stale && (
                          <span className={css.gwStaleBadge} data-testid="stale-skill-badge">
                            {skill.daysSinceLastUse}天零调用 · 建议归档
                          </span>
                        )}
                      </span>
                    </div>

                    <h2 className={css.gwSkillTitle}>{skill.name}</h2>
                    <p className={css.gwSkillDesc}>{skill.description}</p>
                    <p className={css.gwMetaText}>
                      调用 {skill.invocationCount} 次 · 最近调用{' '}
                      {skill.lastInvokedAt ? formatRelativeAgo(skill.lastInvokedAt, model.now) : '从未调用'} ·{' '}
                      {completionText}
                    </p>

                    <label className={css.gwFieldLabel}>
                      生效作用域切换
                      <select
                        className={css.gwFieldSelect}
                        aria-label={`生效作用域切换 ${skill.name}`}
                        value={encodeScopeSelectValue(skill.scope, skill.workspacePath)}
                        onChange={(e) => void handleSkillScopeChange(skill, e.currentTarget.value)}
                      >
                        <option value="global">全局（所有工作区生效）</option>
                        {wsOptions.map(([wsPath, wsDisplay]) => (
                          <option key={wsPath} value={`ws:${wsPath}`}>
                            工作区：{wsDisplay}
                          </option>
                        ))}
                      </select>
                    </label>

                    {wsOptions.length > 0 && (
                      <div className={css.gwInlineFieldRow}>
                        <select
                          className={css.gwFieldSelect}
                          aria-label={`导出目标工作区 ${skill.name}`}
                          value={selectedExportWs}
                          onChange={(e) =>
                            setExportTargetBySkill((prev) => ({ ...prev, [skill.name]: e.currentTarget.value }))
                          }
                        >
                          {wsOptions.map(([wsPath, wsDisplay]) => (
                            <option key={wsPath} value={wsPath}>
                              {wsDisplay}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          aria-label={`导出至 .agents/skills ${skill.name}`}
                          onClick={() => void handleExportSkill(skill)}
                        >
                          导出至 .agents/skills
                        </button>
                      </div>
                    )}

                    {isPreviewing && !isEditing && (
                      <pre className={css.gwCodePreview} data-testid="skill-markdown-preview">
                        {skill.markdown}
                      </pre>
                    )}

                    {isEditing && (
                      <form onSubmit={(e) => void handleSaveSkillEdit(e, skill.name)} data-testid="edit-skill-form">
                        <label className={css.gwFieldLabel}>
                          在线编辑 SKILL.md（保存即热重载 ctx.skills）
                          <textarea
                            className={css.gwFieldTextarea}
                            value={editMarkdown}
                            onChange={(e) => setEditMarkdown(e.currentTarget.value)}
                          />
                        </label>
                        {editValidation && !editValidation.valid && (
                          <p className={css.gwMetaText}>校验提示：{editValidation.errors[0]}</p>
                        )}
                        <div className={css.gwActionRow}>
                          <button type="submit" className={css.gwPrimaryBtn}>
                            保存并热重载
                          </button>
                          <button type="button" onClick={() => setEditingKey(null)}>
                            取消
                          </button>
                        </div>
                      </form>
                    )}

                    <div className={css.gwActionRow}>
                      <button
                        type="button"
                        aria-label={`${isPreviewing ? '收起预览' : '预览 SKILL.md'} ${skill.name}`}
                        onClick={() => {
                          setEditingKey(null);
                          setOpenPreviewId(isPreviewing ? null : editKey);
                        }}
                      >
                        {isPreviewing ? '收起预览' : '预览 SKILL.md'}
                      </button>
                      <button
                        type="button"
                        aria-label={`编辑 SKILL.md ${skill.name}`}
                        onClick={() => beginEditMarkdown(editKey, skill.markdown)}
                      >
                        编辑 SKILL.md
                      </button>
                      <button
                        type="button"
                        aria-label={`${skill.status === 'active' ? '停用' : '启用'} ${skill.name}`}
                        onClick={() => void handleToggleSkillEnabled(skill)}
                      >
                        {skill.status === 'active' ? '停用' : '启用'}
                      </button>
                      <button
                        type="button"
                        className={skill.stale ? css.gwPrimaryBtn : undefined}
                        aria-label={`归档 ${skill.name}`}
                        onClick={() => void handleArchiveSkill(skill.name)}
                      >
                        归档
                      </button>
                    </div>
                  </article>
                );
              })
            ))}

          {tab === 'archived' &&
            (filteredArchived.length === 0 ? (
              <p className={css.gwEmptyHint} data-testid="empty-archived-hint">
                {normQuery ? '没有匹配的已归档技能。' : '当前无已归档技能。'}
              </p>
            ) : (
              filteredArchived.map((arch) => {
                const previewKey = `arch:${arch.name}`;
                const isPreviewing = openPreviewId === previewKey;
                return (
                  <article key={arch.name} className={css.gwSkillCard} data-archived-name={arch.name}>
                    <div className={css.gwCardHead}>
                      <span className={css.gwBadgeRow}>
                        <span className={css.gwChipBadge}>v{arch.version}</span>
                        <span className={css.gwChipBadge}>已归档</span>
                      </span>
                      <span className={css.gwMetaText}>归档于 {formatRelativeAgo(arch.archivedAt, model.now)}</span>
                    </div>

                    <h2 className={css.gwSkillTitle}>{arch.name}</h2>
                    <p className={css.gwSkillDesc}>{arch.description}</p>

                    {isPreviewing && (
                      <pre className={css.gwCodePreview} data-testid="skill-markdown-preview">
                        {arch.markdown}
                      </pre>
                    )}

                    <div className={css.gwActionRow}>
                      <button
                        type="button"
                        className={css.gwPrimaryBtn}
                        aria-label={`恢复启用 ${arch.name}`}
                        onClick={() => void handleRestoreSkill(arch.name)}
                      >
                        恢复启用
                      </button>
                      <button
                        type="button"
                        aria-label={`${isPreviewing ? '收起预览' : '预览 SKILL.md'} ${arch.name}`}
                        onClick={() => setOpenPreviewId(isPreviewing ? null : previewKey)}
                      >
                        {isPreviewing ? '收起预览' : '预览 SKILL.md'}
                      </button>
                      <button
                        type="button"
                        aria-label={`删除归档 ${arch.name}`}
                        onClick={() => void handleDeleteArchived(arch.name)}
                      >
                        删除归档
                      </button>
                    </div>
                  </article>
                );
              })
            ))}
        </div>
      </details>

      <details
        open={guardrailsOpen}
        className={css.gwSection}
        onToggle={(e) => setGuardrailsOpen(e.currentTarget.open)}
      >
        <summary>安全、代谢与隐私护栏</summary>
        <div className={css.gwSectionBody}>
          <p className={css.gwMetaText}>
            遵循 agentskills 纯文本 SKILL.md 标准，零可执行脚本生成、零未授权工作区写入；新技能与 v2+
            修订一律须人工批准后才通过 ctx.skills.registerProvider 动态热挂载；60 天零调用自动标记代谢归档建议，全链路经
            sanitizeForModel 凭据脱敏。
          </p>
        </div>
      </details>
    </div>
  );
}
