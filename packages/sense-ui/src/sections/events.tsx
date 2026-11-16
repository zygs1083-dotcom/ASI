import { useEffect, useMemo, useState } from 'react'
import {
  formatClock,
  formatDuration,
  formatMetricValue,
  formatMinute,
  formatPercent,
  formatSignedDelta,
} from '../format'
import {
  InfoIcon,
  PulseIcon,
  ShieldIcon,
  ThumbDownIcon,
  ThumbUpIcon,
  WarnIcon,
} from '../icons'
import type {
  EventDetail,
  EventLevel,
  SenseEvent,
  SensePanelProps,
} from '../view-model'
import css from './events.module.css'

const PAGE_SIZE = 10
const MAX_EVENTS = 200

const LEVEL_TEXT: Record<EventLevel, string> = {
  record: '记录',
  context: '注入',
  wake: '唤醒',
  suppressed: '已抑制',
}

const LEVEL_ICON: Record<EventLevel, React.ReactNode> = {
  record: <InfoIcon />,
  context: <PulseIcon />,
  wake: <WarnIcon />,
  suppressed: <ShieldIcon />,
}

function isWindowKind(kind: string): boolean {
  return kind.startsWith('window')
}

/** 结构化 detail 行（宿主投影，UI 只读渲染）。 */
function DetailLine({ d }: { d: EventDetail }) {
  switch (d.kind) {
    case 'body.rate':
      return (
        <span className={css.detailLine}>
          指标 {d.metric} · {formatDuration(d.windowMs / 1000)}内变化{' '}
          {formatSignedDelta(d.delta, d.unit)}
          {d.timeToFloorMs != null
            ? ` · 当时预计 ${formatDuration(d.timeToFloorMs / 1000)}后触及底线`
            : ''}
        </span>
      )
    case 'body.anomaly':
      return (
        <span className={css.detailLine}>
          指标 {d.metric} · 当前 {formatMetricValue(d.current, d.unit)} · 基线{' '}
          {formatMetricValue(d.baseline, d.unit)} · 偏离 {formatPercent(d.deviation)}
        </span>
      )
    case 'file.burst':
      return (
        <span className={css.detailLine}>
          {d.directory} · {formatDuration(d.windowMs / 1000)}内 新增 {d.created} ·
          修改 {d.modified} · 删除 {d.deleted}
          {d.excessiveDeletion ? ' · 过量删除' : ''}
        </span>
      )
  }
}

/** 只有告警类事件（结构化 detail / wake / suppressed）才展示有用/噪音反馈。 */
function feedbackEligible(e: SenseEvent): boolean {
  return e.detail != null || e.level === 'wake' || e.level === 'suppressed'
}

/** 反馈图标按钮：细指针下默认透明，悬停/聚焦事件行显现；粗指针常显。 */
function Feedback({
  e,
  onFeedback,
}: {
  e: SenseEvent
  onFeedback: SensePanelProps['onFeedback']
}) {
  return (
    <span className={css.feedback}>
      <button
        type="button"
        className={css.fbBtn}
        aria-label="有用"
        title="有用"
        aria-pressed={e.feedback === 'useful'}
        onClick={() => onFeedback(e.signal.id, 'useful')}
      >
        <ThumbUpIcon />
      </button>
      <button
        type="button"
        className={css.fbBtn}
        aria-label="噪音"
        title="噪音"
        aria-pressed={e.feedback === 'noise'}
        onClick={() => onFeedback(e.signal.id, 'noise')}
      >
        <ThumbDownIcon />
      </button>
    </span>
  )
}

function EventItem({
  e,
  sendTitles,
  onFeedback,
}: {
  e: SenseEvent
  sendTitles: boolean
  onFeedback: SensePanelProps['onFeedback']
}) {
  // 窗口类事件在标题关闭时同时隐藏主体/原因/规则名/detail，不放进 title/aria
  const hideWindow = isWindowKind(e.signal.kind) && !sendTitles
  const eligible = feedbackEligible(e)
  return (
    <li className={css.event} data-level={e.level} data-feedback={eligible || undefined}>
      <span className={css.sevLine} aria-hidden="true" />
      <span className={css.level}>
        {LEVEL_ICON[e.level]}
        <span className={css.levelText}>{LEVEL_TEXT[e.level]}</span>
      </span>
      <span className={css.time}>{formatClock(e.signal.at)}</span>
      <span className={css.subject}>
        {hideWindow ? '窗口标题已隐藏' : e.signal.subject}
        {e.count != null && e.count > 1 ? ` ×${e.count}` : ''}
      </span>
      <span className={css.why}>
        {hideWindow
          ? '已按隐私设置隐藏原因'
          : `${e.reason}${e.ruleName ? `（规则 ${e.ruleName}）` : ''}`}
        {e.cause === 'agent' ? ' · Agent 自己引起' : ''}
      </span>
      {!hideWindow && e.detail && <DetailLine d={e.detail} />}
      {eligible && <Feedback e={e} onFeedback={onFeedback} />}
    </li>
  )
}

interface MinuteGroup {
  minute: number
  events: SenseEvent[]
  wakes: number
}

/** 当前页按分钟分桶，保持新→旧顺序。 */
function groupByMinute(items: SenseEvent[]): MinuteGroup[] {
  const groups = new Map<number, SenseEvent[]>()
  for (const e of items) {
    const m = Math.floor(e.signal.at / 60_000)
    const g = groups.get(m)
    if (g) g.push(e)
    else groups.set(m, [e])
  }
  return [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([minute, events]) => ({
      minute,
      events,
      wakes: events.filter((e) => e.level === 'wake').length,
    }))
}

export function EventsSection({
  model,
  onFeedback,
}: Pick<SensePanelProps, 'model' | 'onFeedback'>) {
  const { sendTitles } = model
  const newest = useMemo(
    () =>
      [...model.events]
        .sort(
          (a, b) => b.signal.at - a.signal.at || b.signal.id.localeCompare(a.signal.id),
        )
        .slice(0, MAX_EVENTS),
    [model.events],
  )
  const totalPages = Math.max(1, Math.ceil(newest.length / PAGE_SIZE))
  const [page, setPage] = useState(0)

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages - 1))
  }, [totalPages])

  const current = Math.min(page, totalPages - 1)
  const pageItems = newest.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE)
  const groups = useMemo(() => groupByMinute(pageItems), [pageItems])

  return (
    <>
      <div className={css.streamMeta}>
        最新 {newest.length} 条（上限 {MAX_EVENTS}） · 第 {current + 1}/{totalPages} 页 · 时间：事件发生时间（变化率为评估时间）；变化率预计从事件时间起算
      </div>
      {pageItems.length === 0 && <div className={css.empty}>暂无事件</div>}
      <ul className={css.list}>
        {groups.map((g) =>
          g.events.length === 1 ? (
            <EventItem
              key={g.events[0]!.signal.id}
              e={g.events[0]!}
              sendTitles={sendTitles}
              onFeedback={onFeedback}
            />
          ) : (
            <li key={g.minute} className={css.minuteGroup}>
              <details open={g.wakes > 0 || undefined}>
                <summary className={css.minuteSummary}>
                  <span className={css.time}>{formatMinute(g.minute * 60_000)}</span>
                  <span>{g.events.length} 条事件</span>
                  {g.wakes > 0 && (
                    <span className={css.wakeBadge}>
                      <WarnIcon />
                      {g.wakes} 次唤醒
                    </span>
                  )}
                </summary>
                <ul className={css.minuteList}>
                  {g.events.map((e) => (
                    <EventItem
                      key={e.signal.id}
                      e={e}
                      sendTitles={sendTitles}
                      onFeedback={onFeedback}
                    />
                  ))}
                </ul>
              </details>
            </li>
          ),
        )}
      </ul>
      {totalPages > 1 && (
        <div className={css.pager}>
          <button
            type="button"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            上一页
          </button>
          <button
            type="button"
            disabled={current >= totalPages - 1}
            onClick={() => setPage(current + 1)}
          >
            下一页
          </button>
        </div>
      )}
    </>
  )
}
