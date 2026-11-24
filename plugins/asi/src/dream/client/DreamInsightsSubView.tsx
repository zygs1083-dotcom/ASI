import type { NeedZone } from '@asi/sense-types';
import { useMemo, useState } from 'react';
import css from '../../client/asi-panel.module.css';
import { searchDreamInsights } from '../shared/search.ts';
import {
  DREAM_INSIGHT_KIND_LABELS,
  DREAM_INSIGHT_KINDS,
  type DreamAdoptMemoryInput,
  type DreamAdoptResult,
  type DreamCycleRecord,
  type DreamInsightKind,
  type DreamInsightStatus,
  type DreamInsightViewItem,
  type DreamPanelModel,
  type DreamPromoteResult,
  type DreamSubTabFilter,
} from '../shared/types.ts';

const ZONE_WORD: Record<NeedZone, string> = {
  comfortable: '舒适',
  uncomfortable: '不适',
  critical: '危急',
};

function formatRelativeAgo(at: number | null | undefined, now: number): string {
  if (at === null || at === undefined || !Number.isFinite(at) || at <= 0) return '从未';
  const diffSec = Math.max(0, Math.floor((now - at) / 1000));
  if (diffSec < 60) return `${diffSec}s 前`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m 前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h 前`;
  return `${Math.floor(hrs / 24)}d 前`;
}

export interface DreamInsightsSubViewProps {
  dreamModel: DreamPanelModel;
  onDreamNow?: () => Promise<DreamCycleRecord | undefined>;
  onToggleAutoDreamPaused?: (paused: boolean) => Promise<void>;
  onAdoptDreamInsight?: (input: DreamAdoptMemoryInput) => Promise<DreamAdoptResult | undefined>;
  onPromoteDreamInsight?: (insightId: string) => Promise<DreamPromoteResult | undefined>;
  onDismissDreamInsight?: (insightId: string) => Promise<DreamInsightViewItem | undefined>;
  onVaultMutated?: () => void;
  onNavigateVault: () => void;
  onNavigateSkillDrafts: () => void;
}

export function DreamInsightsSubView(props: DreamInsightsSubViewProps) {
  const { dreamModel } = props;
  const [dreamQuery, setDreamQuery] = useState('');
  const [dreamStatusFilter, setDreamStatusFilter] = useState<DreamSubTabFilter>('open');
  const [dreamKindFilter, setDreamKindFilter] = useState<DreamInsightKind | 'all'>('all');
  const [busyDream, setBusyDream] = useState(false);
  const [busyInsightId, setBusyInsightId] = useState<string | null>(null);
  const [dreamFeedback, setDreamFeedback] = useState<string | null>(null);
  const [dreamIsError, setDreamIsError] = useState(false);

  const filteredInsights = useMemo(() => {
    const statuses: readonly DreamInsightStatus[] | undefined =
      dreamStatusFilter === 'open'
        ? ['open']
        : dreamStatusFilter === 'resolved'
          ? ['adopted', 'promoted']
          : dreamStatusFilter === 'dismissed'
            ? ['dismissed']
            : undefined;
    return searchDreamInsights(dreamModel.insights, dreamQuery, {
      ...(dreamKindFilter !== 'all' ? { kind: dreamKindFilter } : {}),
      ...(statuses ? { statuses } : {}),
      limit: 120,
    });
  }, [dreamModel.insights, dreamQuery, dreamStatusFilter, dreamKindFilter]);

  const dreamIdleMins = Math.floor(dreamModel.drive.idleDurationMs / 60_000);
  const dreamQuietText = dreamModel.drive.screenLocked
    ? '已锁屏'
    : dreamModel.drive.deepQuietWindow
      ? `空闲 ${dreamIdleMins}m（就绪）`
      : `空闲 ${dreamIdleMins}/15m`;

  const handleDreamNow = async () => {
    if (!props.onDreamNow) return;
    setBusyDream(true);
    setDreamFeedback(null);
    setDreamIsError(false);
    try {
      const rec = await props.onDreamNow();
      setDreamIsError(false);
      setDreamFeedback(rec?.summary ?? '已完成跨项目做梦联想。');
    } catch (err) {
      setDreamIsError(true);
      setDreamFeedback(err instanceof Error ? err.message : '立即做梦联想失败');
    } finally {
      setBusyDream(false);
    }
  };

  const handleToggleAutoDreamPaused = async (paused: boolean) => {
    if (!props.onToggleAutoDreamPaused) return;
    try {
      await props.onToggleAutoDreamPaused(paused);
      setDreamIsError(false);
      setDreamFeedback(paused ? '已暂停自动做梦联想。' : '已恢复深静默自动做梦联想。');
    } catch (err) {
      setDreamIsError(true);
      setDreamFeedback(err instanceof Error ? err.message : '切换自动做梦状态失败');
    }
  };

  const handleAdoptInsight = async (insight: DreamInsightViewItem) => {
    if (!props.onAdoptDreamInsight) return;
    setBusyInsightId(insight.id);
    try {
      const res = await props.onAdoptDreamInsight({ insightId: insight.id, pinned: true });
      setDreamIsError(false);
      setDreamFeedback(`已采纳顿悟并固化为长期记忆（${res?.memoryId ?? '已置顶'}）。`);
      props.onVaultMutated?.();
    } catch (err) {
      setDreamIsError(true);
      setDreamFeedback(err instanceof Error ? err.message : '采纳顿悟失败');
    } finally {
      setBusyInsightId(null);
    }
  };

  const handlePromoteInsight = async (insight: DreamInsightViewItem) => {
    if (!props.onPromoteDreamInsight) return;
    setBusyInsightId(insight.id);
    try {
      const res = await props.onPromoteDreamInsight(insight.id);
      setDreamIsError(false);
      setDreamFeedback(`已生成待审技能草案 ${res?.skillName ?? ''}，可前往「技能工坊」批准启用。`);
    } catch (err) {
      setDreamIsError(true);
      setDreamFeedback(err instanceof Error ? err.message : '转交技能草案失败');
    } finally {
      setBusyInsightId(null);
    }
  };

  const handleDismissInsight = async (insight: DreamInsightViewItem) => {
    if (!props.onDismissDreamInsight) return;
    setBusyInsightId(insight.id);
    try {
      await props.onDismissDreamInsight(insight.id);
      setDreamIsError(false);
      setDreamFeedback(`已忽略「${insight.title}」并降低同类跨仓桥接权重。`);
    } catch (err) {
      setDreamIsError(true);
      setDreamFeedback(err instanceof Error ? err.message : '忽略顿悟失败');
    } finally {
      setBusyInsightId(null);
    }
  };

  return (
    <>
      <section className={css.card} aria-label="DMN 睡眠做梦与跨项目顿悟状态" data-testid="dream-status-card">
        <div className={css.cardHeader}>
          <span className={css.badgeGroup}>
            <span className={css.tierPill}>DMN</span>
            <h2 className={css.sectionHeading}>睡眠做梦与跨项目顿悟</h2>
            <span className={css.tagPill} data-zone={dreamModel.drive.zone}>
              {dreamModel.drive.suppressed || dreamModel.drive.lowerTierBlocked
                ? '已挂起'
                : ZONE_WORD[dreamModel.drive.zone]}
            </span>
            {dreamModel.autoDreamPaused && (
              <span className={css.tagPill} data-zone="uncomfortable">
                自动做梦已暂停
              </span>
            )}
          </span>
          <span className={css.scoreNum}>满足 {Math.round(dreamModel.drive.satisfaction)}%</span>
        </div>

        <p className={css.mutedText}>
          已关联仓库 {dreamModel.drive.discoveredRepoCount} · 候选桥接 {dreamModel.drive.candidateBridgeCount} ·{' '}
          {dreamQuietText} · 今日自动 {dreamModel.drive.autoDreamsToday}/{dreamModel.drive.dailyAutoQuota} 次 · 上次{' '}
          {formatRelativeAgo(dreamModel.drive.lastDreamAt, dreamModel.now)}
        </p>

        <div className={css.actionRow}>
          <button
            type="button"
            className={css.primaryBtn}
            data-testid="dream-now-btn"
            disabled={!props.onDreamNow || busyDream || dreamModel.dreaming}
            onClick={() => void handleDreamNow()}
          >
            {busyDream || dreamModel.dreaming ? '做梦联想中…' : '立即做梦联想'}
          </button>

          <label className={css.toggleRow}>
            <input
              type="checkbox"
              data-testid="auto-dream-pause-toggle"
              disabled={!props.onToggleAutoDreamPaused}
              checked={dreamModel.autoDreamPaused}
              onChange={(e) => void handleToggleAutoDreamPaused(e.currentTarget.checked)}
            />
            暂停自动做梦
          </label>
        </div>

        {dreamFeedback && (
          <div
            role={dreamIsError ? 'alert' : 'status'}
            className={dreamIsError ? css.alertBanner : css.feedbackBanner}
            data-testid="dream-feedback"
          >
            <span>{dreamFeedback}</span>
            <button
              type="button"
              className={css.textBtn}
              onClick={() => {
                setDreamFeedback(null);
                setDreamIsError(false);
              }}
            >
              关闭
            </button>
          </div>
        )}
      </section>

      <section className={css.card} aria-label="跨项目顿悟检索与筛选">
        <div className={css.searchBar}>
          <input
            type="search"
            className={css.fieldInput}
            aria-label="搜索跨项目顿悟"
            data-testid="dream-search-input"
            placeholder="搜索仓库名、同构机制、避坑假说…"
            value={dreamQuery}
            onChange={(e) => setDreamQuery(e.currentTarget.value)}
          />
          {dreamQuery && (
            <button type="button" className={css.btn} onClick={() => setDreamQuery('')} aria-label="清空顿悟搜索词">
              清空
            </button>
          )}
        </div>

        <fieldset className={css.pillRow}>
          <legend className={css.srOnly}>顿悟状态筛选</legend>
          <button
            type="button"
            data-testid="dream-filter-open"
            className={`${css.filterPill} ${dreamStatusFilter === 'open' ? css.filterPillActive : ''}`}
            aria-pressed={dreamStatusFilter === 'open'}
            onClick={() => setDreamStatusFilter('open')}
          >
            待审 ({dreamModel.openCount})
          </button>
          <button
            type="button"
            data-testid="dream-filter-resolved"
            className={`${css.filterPill} ${dreamStatusFilter === 'resolved' ? css.filterPillActive : ''}`}
            aria-pressed={dreamStatusFilter === 'resolved'}
            onClick={() => setDreamStatusFilter('resolved')}
          >
            已转化 ({dreamModel.adoptedCount + dreamModel.promotedCount})
          </button>
          <button
            type="button"
            data-testid="dream-filter-dismissed"
            className={`${css.filterPill} ${dreamStatusFilter === 'dismissed' ? css.filterPillActive : ''}`}
            aria-pressed={dreamStatusFilter === 'dismissed'}
            onClick={() => setDreamStatusFilter('dismissed')}
          >
            已忽略 ({dreamModel.dismissedCount})
          </button>
          <button
            type="button"
            data-testid="dream-filter-all"
            className={`${css.filterPill} ${dreamStatusFilter === 'all' ? css.filterPillActive : ''}`}
            aria-pressed={dreamStatusFilter === 'all'}
            onClick={() => setDreamStatusFilter('all')}
          >
            全部顿悟 ({dreamModel.totalInsights})
          </button>
        </fieldset>

        <fieldset className={css.pillRow}>
          <legend className={css.srOnly}>顿悟类别筛选</legend>
          <button
            type="button"
            className={`${css.filterPill} ${dreamKindFilter === 'all' ? css.filterPillActive : ''}`}
            aria-pressed={dreamKindFilter === 'all'}
            onClick={() => setDreamKindFilter('all')}
          >
            全部分类
          </button>
          {DREAM_INSIGHT_KINDS.map((dk) => (
            <button
              key={dk}
              type="button"
              className={`${css.filterPill} ${dreamKindFilter === dk ? css.filterPillActive : ''}`}
              aria-pressed={dreamKindFilter === dk}
              onClick={() => setDreamKindFilter(dk)}
            >
              {DREAM_INSIGHT_KIND_LABELS[dk]}
            </button>
          ))}
        </fieldset>
      </section>

      {filteredInsights.length === 0 ? (
        <section className={css.card} aria-label="顿悟空状态">
          <p className={css.mutedText}>
            {dreamModel.totalInsights === 0
              ? '尚未生成跨项目顿悟。当关联 >=2 个独立仓库且进入深静默（或点击「立即做梦联想」）时，DMN 将自动发掘跨仓同构与避坑预警。'
              : '当前筛选条件下暂无匹配的跨项目顿悟。'}
          </p>
        </section>
      ) : (
        filteredInsights.map((ins) => {
          const isBusy = busyInsightId === ins.id;
          const confPct = Math.round(ins.confidence * 100);
          const novPct = Math.round(ins.noveltyScore * 100);
          const statusLabel =
            ins.status === 'open'
              ? '待审顿悟'
              : ins.status === 'adopted'
                ? '已固化记忆'
                : ins.status === 'promoted'
                  ? '已转技能草案'
                  : '已忽略降权';

          return (
            <article key={ins.id} className={css.card} data-insight-id={ins.id}>
              <div className={css.cardHeader}>
                <span className={css.badgeGroup}>
                  <span
                    className={css.tagPill}
                    data-zone={
                      ins.kind === 'preventive-warning' || ins.kind === 'decision-tension'
                        ? 'uncomfortable'
                        : 'comfortable'
                    }
                  >
                    {DREAM_INSIGHT_KIND_LABELS[ins.kind]}
                  </span>
                  <span className={css.tagPill} data-zone={ins.status === 'open' ? 'uncomfortable' : 'comfortable'}>
                    {statusLabel}
                  </span>
                </span>
                <span className={css.scoreNum}>
                  置信 {confPct}% · 新颖 {novPct}%
                </span>
              </div>

              <h3 className={css.sectionHeading}>{ins.title}</h3>
              <p className={css.mutedText}>
                关联仓库：{ins.sourceRepos.join(' ↔ ')}
                {ins.targetRepo ? ` · 受益目标：${ins.targetRepo}` : ''}
              </p>
              <p className={css.bodyText}>{ins.summary}</p>
              <p className={css.mutedText}>
                <strong>同构机制：</strong>
                {ins.bridgeMechanism}
              </p>
              <p className={css.mutedText}>
                <strong>行动假说：</strong>
                {ins.actionableHypothesis}
              </p>

              {ins.tags.length > 0 && (
                <ul className={css.tagChips} aria-label="顿悟标签">
                  {ins.tags.map((tag) => (
                    <li key={tag} className={css.tagChip}>
                      #{tag}
                    </li>
                  ))}
                </ul>
              )}

              <div className={css.actionRow}>
                {ins.status === 'open' && (
                  <>
                    <button
                      type="button"
                      className={css.primaryBtn}
                      data-testid={`adopt-insight-${ins.id}`}
                      disabled={!props.onAdoptDreamInsight || isBusy}
                      onClick={() => void handleAdoptInsight(ins)}
                    >
                      采纳为记忆
                    </button>
                    <button
                      type="button"
                      className={css.btn}
                      data-testid={`promote-insight-${ins.id}`}
                      disabled={!props.onPromoteDreamInsight || isBusy}
                      onClick={() => void handlePromoteInsight(ins)}
                    >
                      转交技能草案
                    </button>
                    <button
                      type="button"
                      className={css.btn}
                      data-testid={`dismiss-insight-${ins.id}`}
                      disabled={!props.onDismissDreamInsight || isBusy}
                      onClick={() => void handleDismissInsight(ins)}
                    >
                      忽略降权
                    </button>
                  </>
                )}
                {ins.status === 'adopted' && (
                  <button type="button" className={css.btn} onClick={props.onNavigateVault}>
                    查看长期记忆
                  </button>
                )}
                {ins.status === 'promoted' && (
                  <button type="button" className={css.btn} onClick={props.onNavigateSkillDrafts}>
                    前往技能工坊审阅
                  </button>
                )}
              </div>
            </article>
          );
        })
      )}

      <details className={css.drawer} data-testid="drawer-dream-journal">
        <summary>
          <span>最近 DMN 做梦日志（{dreamModel.recentDreams.length}）</span>
          <span className={css.drawerChevron} aria-hidden="true">
            ▸
          </span>
        </summary>
        <div className={css.drawerBody}>
          {dreamModel.recentDreams.length === 0 ? (
            <p className={css.mutedText}>暂无 DMN 做梦记录。</p>
          ) : (
            <ul className={css.compactList} aria-label="最近 DMN 做梦记录">
              {dreamModel.recentDreams.slice(0, 5).map((rec) => (
                <li key={rec.id} className={css.compactListItem}>
                  <div className={css.needRowTop}>
                    <strong>{rec.trigger === 'manual' ? '手动做梦' : '深静默自动做梦'}</strong>
                    <span className={css.scoreNum}>{formatRelativeAgo(rec.at, dreamModel.now)}</span>
                  </div>
                  <span className={css.mutedText}>{rec.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </>
  );
}
