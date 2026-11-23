import type { NeedZone } from '@asi/sense-types';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { searchMemoryItems } from '../shared/search.js';
import {
  MEMORY_KIND_LABELS,
  MEMORY_KINDS,
  type MemoryCreateInput,
  type MemoryKind,
  type MemoryUpdateInput,
  type MemoryViewItem,
  type SleepConsolidationRecord,
  type SleepPanelModel,
} from '../shared/types.js';
import css from './sleep-panel.module.css';

export interface SleepPanelActions {
  onConsolidateNow: () => Promise<SleepConsolidationRecord | undefined>;
  onToggleAutoSleepPaused: (paused: boolean) => Promise<void>;
  onCreateMemory: (input: MemoryCreateInput) => Promise<MemoryViewItem | undefined>;
  onUpdateMemory: (id: string, patch: MemoryUpdateInput) => Promise<MemoryViewItem | undefined>;
  onTogglePin: (id: string, pinned: boolean) => Promise<MemoryViewItem | undefined>;
  onDeleteMemory: (id: string) => Promise<void>;
  onSearchMemories?: (query: string, kind?: MemoryKind) => Promise<MemoryViewItem[]>;
}

export interface SleepPanelProps extends SleepPanelActions {
  model: SleepPanelModel;
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

function parseTagsInput(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 10);
}

export function SleepPanel(props: SleepPanelProps) {
  const { model } = props;
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<MemoryKind | 'all'>('all');
  const [creating, setCreating] = useState(false);
  const [createKind, setCreateKind] = useState<MemoryKind>('preference');
  const [createTitle, setCreateTitle] = useState('');
  const [createContent, setCreateContent] = useState('');
  const [createTags, setCreateTags] = useState('');
  const [createPinned, setCreatePinned] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editKind, setEditKind] = useState<MemoryKind>('preference');
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editPinned, setEditPinned] = useState(false);

  const [busyConsolidate, setBusyConsolidate] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [remoteSearchResults, setRemoteSearchResults] = useState<MemoryViewItem[] | null>(null);

  const hasOverflowVault = model.totalMemories > model.memories.length;
  const onSearchMemories = props.onSearchMemories;

  useEffect(() => {
    if (!hasOverflowVault || !onSearchMemories || (!query.trim() && kindFilter === 'all')) {
      setRemoteSearchResults(null);
      return;
    }
    let cancelled = false;
    void onSearchMemories(query, kindFilter === 'all' ? undefined : kindFilter)
      .then((items) => {
        if (!cancelled) setRemoteSearchResults(items);
      })
      .catch(() => {
        if (!cancelled) setRemoteSearchResults(null);
      });
    return () => {
      cancelled = true;
    };
  }, [hasOverflowVault, onSearchMemories, query, kindFilter]);

  const filteredMemories = useMemo(() => {
    if (remoteSearchResults !== null) {
      return remoteSearchResults;
    }
    return searchMemoryItems(model.memories, query, {
      ...(kindFilter !== 'all' ? { kind: kindFilter } : {}),
      includeLowRetention: true,
      limit: 500,
    });
  }, [model.memories, query, kindFilter, remoteSearchResults]);

  const handleToggleAutoSleepPaused = async (paused: boolean) => {
    try {
      await props.onToggleAutoSleepPaused(paused);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '更新自动睡眠设置失败');
    }
  };

  const handleTogglePin = async (id: string, nextPinned: boolean) => {
    try {
      await props.onTogglePin(id, nextPinned);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '更新置顶状态失败');
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      await props.onDeleteMemory(id);
      if (editingId === id) setEditingId(null);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '删除记忆失败');
    }
  };

  const handleConsolidateNow = async () => {
    if (busyConsolidate || model.consolidating) return;
    setBusyConsolidate(true);
    setFeedback(null);
    try {
      const rec = await props.onConsolidateNow();
      if (rec && typeof rec === 'object' && 'summary' in rec && rec.summary) {
        setFeedback(rec.summary);
      } else {
        setFeedback('已完成立即睡眠整合。');
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '睡眠整合执行失败');
    } finally {
      setBusyConsolidate(false);
    }
  };

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!createTitle.trim() || !createContent.trim()) return;
    try {
      await props.onCreateMemory({
        kind: createKind,
        title: createTitle.trim(),
        content: createContent.trim(),
        tags: parseTagsInput(createTags),
        pinned: createPinned,
      });
      setCreateTitle('');
      setCreateContent('');
      setCreateTags('');
      setCreatePinned(false);
      setCreating(false);
      setFeedback('已新建记忆条目。');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '新建记忆失败');
    }
  };

  const beginEdit = (item: MemoryViewItem) => {
    setEditingId(item.id);
    setEditKind(item.kind);
    setEditTitle(item.title);
    setEditContent(item.content);
    setEditTags(item.tags.join(', '));
    setEditPinned(item.pinned);
  };

  const handleEditSubmit = async (e: FormEvent, id: string) => {
    e.preventDefault();
    if (!editTitle.trim() || !editContent.trim()) return;
    try {
      await props.onUpdateMemory(id, {
        kind: editKind,
        title: editTitle.trim(),
        content: editContent.trim(),
        tags: parseTagsInput(editTags),
        pinned: editPinned,
      });
      setEditingId(null);
      setFeedback('已保存记忆修改。');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : '更新记忆失败');
    }
  };

  const { drive } = model;
  const sat = Math.max(0, Math.min(100, Math.round(drive.satisfaction)));
  const urg = Math.max(0, Math.min(100, Math.round(drive.urgency)));
  const idleMinutes = Math.floor(drive.idleDurationMs / 60_000);
  const quietStatusText = drive.screenLocked
    ? '已锁屏（静默就绪）'
    : drive.quietWindow
      ? `空闲 ${idleMinutes} 分钟（静默就绪）`
      : `空闲 ${idleMinutes}/10 分钟`;

  return (
    <div className={`${css.panel} ${model.stale ? css.stalePanel : ''}`} data-panel data-testid="asi-sleep-panel">
      <header className={css.header}>
        <h1 className={css.title}>记忆库</h1>
        <span className={css.privacyBadge} title="记忆数据经脱敏仅保存在本机">
          <ShieldIcon />
          仅本机
        </span>
        {(model.consolidating || busyConsolidate) && (
          <span className={`${css.statusTag} ${css.activeTag}`}>整合中</span>
        )}
        {drive.suppressed && <span className={`${css.statusTag} ${css.warnTag}`}>已挂起</span>}
        {model.autoSleepPaused && <span className={`${css.statusTag} ${css.warnTag}`}>自动睡眠已暂停</span>}
      </header>

      <details open className={css.section}>
        <summary>睡眠稳态与整合</summary>
        <div className={css.sectionBody}>
          <div className={css.driveCard} data-zone={drive.zone} data-suppressed={drive.suppressed ? 'true' : 'false'}>
            <div className={css.driveHead}>
              <span className={css.badgeRow}>
                <span className={css.tierBadge}>L2</span>
                <strong>睡眠记忆整合</strong>
                <span className={css.zoneBadge} data-zone={drive.zone}>
                  {ZONE_WORD[drive.zone]}
                </span>
              </span>
              <span className={css.metaText}>
                满足 {sat}% · 紧迫 {urg}%
              </span>
            </div>
            <div className={css.meterTrack} aria-hidden="true">
              <i className={css.meterFill} data-zone={drive.zone} style={{ width: `${sat}%` }} />
            </div>
            <div className={css.metaText}>{drive.summary}</div>
            <div className={css.metricsGrid}>
              <span className={css.metricItem}>
                待整合：
                <strong>
                  {drive.unconsolidatedTurns}/{drive.turnThreshold} 轮
                </strong>
              </span>
              <span className={css.metricItem}>
                静默窗：<strong>{quietStatusText}</strong>
              </span>
              <span className={css.metricItem}>
                自动配额：
                <strong>
                  {drive.autoRunsToday}/{drive.dailyAutoQuota} 次/日
                </strong>
              </span>
              <span className={css.metricItem}>
                上次睡眠：<strong>{formatRelativeAgo(drive.lastSleepAt, model.now)}</strong>
              </span>
            </div>
          </div>

          <div className={css.actionRow}>
            <button
              type="button"
              className={css.primaryBtn}
              data-testid="consolidate-now-btn"
              disabled={busyConsolidate || model.consolidating}
              onClick={() => void handleConsolidateNow()}
            >
              {busyConsolidate || model.consolidating ? '睡眠整合中…' : '立即睡眠整合'}
            </button>

            <label className={css.toggleRow}>
              <input
                type="checkbox"
                data-testid="auto-sleep-pause-toggle"
                checked={model.autoSleepPaused}
                onChange={(e) => void handleToggleAutoSleepPaused(e.currentTarget.checked)}
              />
              暂停自动睡眠整合
            </label>
          </div>

          {feedback && (
            <div role="status" className={css.feedbackBanner} data-testid="sleep-feedback">
              {feedback}
            </div>
          )}

          {model.recentConsolidations.length > 0 && (
            <ul className={css.journalList} aria-label="最近睡眠整合记录">
              {model.recentConsolidations.slice(0, 2).map((rec) => (
                <li key={rec.id}>
                  [{rec.trigger === 'manual' ? '手动' : '自动'} · {formatRelativeAgo(rec.at, model.now)}] {rec.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      <details open className={css.section}>
        <summary>记忆检索与管理（{model.totalMemories}）</summary>
        <div className={css.sectionBody}>
          <div className={css.searchBar}>
            <input
              type="search"
              className={css.searchInput}
              aria-label="搜索记忆库"
              data-testid="memory-search-input"
              placeholder="搜索偏好、决策、踩坑、进展…"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="清空搜索词">
                清空
              </button>
            )}
          </div>

          <fieldset className={css.filterRow}>
            <legend className={css.srOnly}>记忆类型筛选</legend>
            <button
              type="button"
              className={`${css.filterPill} ${kindFilter === 'all' ? css.filterPillActive : ''}`}
              aria-pressed={kindFilter === 'all'}
              onClick={() => setKindFilter('all')}
            >
              全部 ({model.totalMemories})
            </button>
            {MEMORY_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={`${css.filterPill} ${kindFilter === k ? css.filterPillActive : ''}`}
                aria-pressed={kindFilter === k}
                onClick={() => setKindFilter(k)}
              >
                {MEMORY_KIND_LABELS[k]} ({model.countsByKind[k] ?? 0})
              </button>
            ))}
          </fieldset>

          <div className={css.actionRow}>
            <button
              type="button"
              data-testid="new-memory-btn"
              onClick={() => {
                setCreating((prev) => !prev);
                setEditingId(null);
              }}
            >
              {creating ? '收起新建表单' : '+ 新建记忆'}
            </button>
          </div>

          {creating && (
            <form
              className={css.editorCard}
              onSubmit={(e) => void handleCreateSubmit(e)}
              data-testid="create-memory-form"
            >
              <label className={css.fieldLabel}>
                记忆类型
                <select
                  className={css.fieldSelect}
                  value={createKind}
                  onChange={(e) => setCreateKind(e.currentTarget.value as MemoryKind)}
                >
                  {MEMORY_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {MEMORY_KIND_LABELS[k]} ({k})
                    </option>
                  ))}
                </select>
              </label>
              <label className={css.fieldLabel}>
                标题
                <input
                  type="text"
                  className={css.fieldInput}
                  required
                  value={createTitle}
                  onChange={(e) => setCreateTitle(e.currentTarget.value)}
                  placeholder="简要概括记忆要点"
                />
              </label>
              <label className={css.fieldLabel}>
                详细内容
                <textarea
                  className={css.fieldTextarea}
                  required
                  value={createContent}
                  onChange={(e) => setCreateContent(e.currentTarget.value)}
                  placeholder="结构化描述背景、结论或避坑细节"
                />
              </label>
              <label className={css.fieldLabel}>
                标签（逗号分隔）
                <input
                  type="text"
                  className={css.fieldInput}
                  value={createTags}
                  onChange={(e) => setCreateTags(e.currentTarget.value)}
                  placeholder="例如 pnpm, typescript"
                />
              </label>
              <label className={css.toggleRow}>
                <input
                  type="checkbox"
                  checked={createPinned}
                  onChange={(e) => setCreatePinned(e.currentTarget.checked)}
                />
                置顶（锁定保留率 100%，永不衰减修剪）
              </label>
              <div className={css.cardActions}>
                <button type="submit" className={css.primaryBtn}>
                  保存记忆
                </button>
                <button type="button" onClick={() => setCreating(false)}>
                  取消
                </button>
              </div>
            </form>
          )}

          {filteredMemories.length === 0 ? (
            <p className={css.emptyHint} data-testid="empty-memories-hint">
              {query || kindFilter !== 'all'
                ? '没有匹配的记忆条目。'
                : '当前记忆库为空，可通过对话积累睡眠整合或手动新建。'}
            </p>
          ) : (
            filteredMemories.map((item) => {
              const retentionPct = Math.round(Math.max(0, Math.min(1, item.retention)) * 100);
              const isEditing = editingId === item.id;
              return (
                <article
                  key={item.id}
                  className={css.memoryCard}
                  data-memory-id={item.id}
                  data-memory-kind={item.kind}
                  data-pinned={item.pinned ? 'true' : 'false'}
                >
                  {isEditing ? (
                    <form onSubmit={(e) => void handleEditSubmit(e, item.id)} data-testid="edit-memory-form">
                      <label className={css.fieldLabel}>
                        记忆类型
                        <select
                          className={css.fieldSelect}
                          value={editKind}
                          onChange={(e) => setEditKind(e.currentTarget.value as MemoryKind)}
                        >
                          {MEMORY_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {MEMORY_KIND_LABELS[k]} ({k})
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={css.fieldLabel}>
                        标题
                        <input
                          type="text"
                          className={css.fieldInput}
                          required
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.currentTarget.value)}
                        />
                      </label>
                      <label className={css.fieldLabel}>
                        详细内容
                        <textarea
                          className={css.fieldTextarea}
                          required
                          value={editContent}
                          onChange={(e) => setEditContent(e.currentTarget.value)}
                        />
                      </label>
                      <label className={css.fieldLabel}>
                        标签（逗号分隔）
                        <input
                          type="text"
                          className={css.fieldInput}
                          value={editTags}
                          onChange={(e) => setEditTags(e.currentTarget.value)}
                        />
                      </label>
                      <label className={css.toggleRow}>
                        <input
                          type="checkbox"
                          checked={editPinned}
                          onChange={(e) => setEditPinned(e.currentTarget.checked)}
                        />
                        置顶（永不衰减）
                      </label>
                      <div className={css.cardActions}>
                        <button type="submit" className={css.primaryBtn}>
                          保存修改
                        </button>
                        <button type="button" onClick={() => setEditingId(null)}>
                          取消
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className={css.driveHead}>
                        <span className={css.badgeRow}>
                          <span className={css.kindBadge}>{MEMORY_KIND_LABELS[item.kind]}</span>
                          {item.pinned && <span className={css.pinBadge}>已置顶 · 永不衰减</span>}
                        </span>
                        <span className={css.metaText}>{formatRelativeAgo(item.updatedAt, model.now)}</span>
                      </div>

                      <h2 className={css.memoryTitle}>{item.title}</h2>
                      <p className={css.memoryContent}>{item.content}</p>

                      <div className={css.retentionRow}>
                        <span className={css.retentionTrack} aria-hidden="true">
                          <i className={css.retentionFill} style={{ width: `${retentionPct}%` }} />
                        </span>
                        <span>
                          {item.pinned
                            ? '保留率 100%（已置顶锁定）'
                            : `FSRS 保留 ${retentionPct}% · S=${item.fsrs.stability.toFixed(1)}d · 回忆 ${item.recallCount} 次`}
                        </span>
                      </div>

                      {item.tags.length > 0 && (
                        <ul className={css.tagList} aria-label="记忆标签">
                          {item.tags.map((tag) => (
                            <li key={tag} className={css.tagChip}>
                              #{tag}
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className={css.cardActions}>
                        <button
                          type="button"
                          aria-label={`${item.pinned ? '取消置顶' : '置顶'} ${item.title}`}
                          onClick={() => void handleTogglePin(item.id, !item.pinned)}
                        >
                          {item.pinned ? '取消置顶' : '置顶'}
                        </button>
                        <button type="button" aria-label={`编辑 ${item.title}`} onClick={() => beginEdit(item)}>
                          编辑
                        </button>
                        <button
                          type="button"
                          aria-label={`删除 ${item.title}`}
                          onClick={() => void handleDeleteMemory(item.id)}
                        >
                          删除
                        </button>
                      </div>
                    </>
                  )}
                </article>
              );
            })
          )}
        </div>
      </details>

      <details open={privacyOpen} className={css.section} onToggle={(e) => setPrivacyOpen(e.currentTarget.open)}>
        <summary>隐私与架构护栏</summary>
        <div className={css.sectionBody}>
          <p className={css.metaText}>
            日常对话仅通过只读工具 memory_recall 与 memory_profile 按需读取，绝不动态注入消息或改写系统提示词（100% 保护
            Prompt Cache）；自动跳过后台维护沙盒与子代理会话，落盘前后与工具输出前均经 sanitizeForModel 脱敏。
          </p>
        </div>
      </details>
    </div>
  );
}
