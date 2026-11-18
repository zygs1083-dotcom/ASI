import { useCallback, useEffect, useRef, useState } from 'react';
import { formatClock, formatTimestamp } from '../format';
import type { MonthlySummaryLoadResult, MonthlySummaryView, SensePanelModel } from '../view-model';
import css from './history.module.css';
import {
  DaySummaryBlock,
  formatAwayHours,
  formatMs,
  METRIC_SPECS,
  Metric24hCard,
  SummaryDigest,
} from './history-cards';
import { ConfirmAction } from './tuning-actions';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function dispatchAsync<T>(run: () => Promise<T>, onOk: (value: T) => void, onErr: (error: unknown) => void): void {
  try {
    Promise.resolve(run()).then(onOk, onErr);
  } catch (error) {
    onErr(error);
  }
}

export interface HistorySectionProps {
  model: SensePanelModel;
  open: boolean;
  onListMonths?: () => Promise<string[]>;
  onLoadMonthly?: (month: string) => Promise<MonthlySummaryLoadResult>;
  onClearHistory?: () => Promise<void>;
}

export function HistorySection({ model, open, onListMonths, onLoadMonthly, onClearHistory }: HistorySectionProps) {
  const { timeline } = model;
  const [monthsState, setMonthsState] = useState<
    | { status: 'idle'; months: string[] }
    | { status: 'loading'; months: string[] }
    | { status: 'error'; months: string[]; error: string }
    | { status: 'ready'; months: string[] }
  >({ status: 'idle', months: [] });
  const [selectedMonth, setSelectedMonth] = useState('');
  const [monthlyState, setMonthlyState] = useState<
    | { status: 'idle' }
    | { status: 'loading'; month: string }
    | { status: 'empty'; month: string; reason: string }
    | { status: 'error'; month: string; error: string }
    | { status: 'ready'; month: string; summary: MonthlySummaryView }
  >({ status: 'idle' });
  const [clearStatus, setClearStatus] = useState<
    { kind: 'idle' } | { kind: 'pending' } | { kind: 'success'; text: string } | { kind: 'error'; text: string }
  >({ kind: 'idle' });

  const monthsSeq = useRef(0);
  const monthlySeq = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshMonths = useCallback(() => {
    if (!onListMonths) {
      setMonthsState({ status: 'ready', months: [] });
      return;
    }
    const seq = ++monthsSeq.current;
    setMonthsState((prev) => ({ status: 'loading', months: prev.months }));
    dispatchAsync(
      onListMonths,
      (list) => {
        if (!mounted.current || seq !== monthsSeq.current) return;
        setMonthsState({ status: 'ready', months: list });
        setSelectedMonth((cur) => {
          if (cur && !list.includes(cur)) {
            monthlySeq.current += 1;
            setMonthlyState({ status: 'idle' });
            return '';
          }
          return cur;
        });
      },
      (err) => {
        if (!mounted.current || seq !== monthsSeq.current) return;
        setMonthsState({ status: 'error', months: [], error: errorMessage(err, '月份列表加载失败') });
      },
    );
  }, [onListMonths]);

  useEffect(() => {
    if (!open) return;
    refreshMonths();
  }, [open, refreshMonths]);

  const fetchMonthly = useCallback(
    (month: string) => {
      setSelectedMonth(month);
      if (!month) {
        monthlySeq.current += 1;
        setMonthlyState({ status: 'idle' });
        return;
      }
      if (!onLoadMonthly) {
        setMonthlyState({ status: 'empty', month, reason: '暂不支持加载月度总结' });
        return;
      }
      const seq = ++monthlySeq.current;
      setMonthlyState({ status: 'loading', month });
      dispatchAsync(
        () => onLoadMonthly(month),
        (res) => {
          if (!mounted.current || seq !== monthlySeq.current) return;
          if (!res.available) {
            setMonthlyState({ status: 'empty', month, reason: res.reason || '该月份暂无月度总结数据' });
          } else {
            setMonthlyState({ status: 'ready', month, summary: res.summary });
          }
        },
        (err) => {
          if (!mounted.current || seq !== monthlySeq.current) return;
          setMonthlyState({ status: 'error', month, error: errorMessage(err, '月度总结加载失败') });
        },
      );
    },
    [onLoadMonthly],
  );

  const handleClearConfirm = () => {
    if (!onClearHistory) return;
    setClearStatus({ kind: 'pending' });
    dispatchAsync(
      onClearHistory,
      () => {
        if (!mounted.current) return;
        monthlySeq.current += 1;
        setSelectedMonth('');
        setMonthlyState({ status: 'idle' });
        setClearStatus({ kind: 'success', text: '已清除全部历史数据。' });
        if (open) refreshMonths();
      },
      (err) => {
        if (!mounted.current) return;
        setClearStatus({ kind: 'error', text: errorMessage(err, '清除历史失败，请重试。') });
      },
    );
  };

  const away = timeline?.lastAway;

  return (
    <div className={css.root}>
      <DaySummaryBlock today={timeline?.today} yesterday={timeline?.yesterday} />

      <div className={css.block}>
        <div className={css.blockHead}>
          <span className={css.blockTitle}>24 小时走势</span>
          {timeline?.metrics && <span className={css.metaLine}>阴影为 5 分钟极值带</span>}
        </div>
        {timeline?.metrics ? (
          <div className={css.charts}>
            {METRIC_SPECS.map((spec) => (
              <Metric24hCard
                key={spec.key}
                label={spec.label}
                metric={spec.metric}
                series={timeline.metrics?.[spec.key]}
                now={timeline?.metrics?.cutoffAt ?? model.now}
                paused={model.paused}
              />
            ))}
          </div>
        ) : (
          <div className={css.empty}>暂无 24 小时指标数据</div>
        )}
      </div>

      <div className={css.block}>
        <span className={css.blockTitle}>最近一次离开</span>
        {!away ? (
          <div className={css.empty}>暂无离开记录</div>
        ) : !away.hasAnomaly ? (
          <div className={css.awayCalm}>离开 {formatAwayHours(away.durationMs)}，无异常</div>
        ) : (
          <div className={css.awayAnomaly} data-anomaly="true">
            <div className={css.awayHead}>
              <span>离开 {formatAwayHours(away.durationMs)} · 发现异常</span>
              <span className={css.badge} data-pushed={away.pushed ? 'true' : 'false'}>
                {away.pushed ? '已推送' : '未推送'}
              </span>
            </div>
            <div className={css.metaLine}>
              {formatTimestamp(away.awayFrom)} – {formatClock(away.returnAt)}
            </div>
            <ul className={css.anomalyList}>
              {(away.anomalies.length > 0 ? away.anomalies : ['检测到离开期间异常']).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className={css.block}>
        <span className={css.blockTitle}>月度总结</span>
        {monthsState.status === 'loading' ? (
          <div className={css.empty} role="status">
            正在加载月份列表…
          </div>
        ) : monthsState.status === 'error' ? (
          <div className={css.errorRow} role="alert">
            <span>{monthsState.error}</span>
            <button type="button" onClick={refreshMonths}>
              重试
            </button>
          </div>
        ) : monthsState.months.length === 0 ? (
          <div className={css.empty}>暂无已完成的月度总结（每月结束后生成）</div>
        ) : (
          <>
            <div className={css.monthRow}>
              <select
                className={css.monthSelect}
                aria-label="选择月份"
                value={selectedMonth}
                onChange={(e) => fetchMonthly(e.target.value)}
              >
                <option value="">请选择月份</option>
                {monthsState.months.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            {monthlyState.status === 'loading' && (
              <div className={css.empty} role="status" aria-busy="true">
                正在加载 {monthlyState.month} 月度总结…
              </div>
            )}
            {monthlyState.status === 'empty' && <div className={css.empty}>{monthlyState.reason}</div>}
            {monthlyState.status === 'error' && (
              <div className={css.errorRow} role="alert">
                <span>{monthlyState.error}</span>
                <button type="button" onClick={() => fetchMonthly(monthlyState.month)}>
                  重试
                </button>
              </div>
            )}
            {monthlyState.status === 'ready' && (
              <SummaryDigest
                summary={monthlyState.summary}
                subtitle={`${monthlyState.summary.month} · 已覆盖 ${monthlyState.summary.coveredDays}/${monthlyState.summary.daysInMonth} 天 · 观测 ${formatMs(monthlyState.summary.observedMs)}`}
                note={
                  monthlyState.summary.partial
                    ? (monthlyState.summary.note ?? '部分天仍在后台补算，可稍后重试查看完整数据。')
                    : undefined
                }
              />
            )}
          </>
        )}
      </div>

      <div className={css.block}>
        <ConfirmAction
          label="清除历史"
          confirmLabel="确认清除"
          message="将删掉 30 天明细、日汇总和月度总结，不可撤销。"
          disabled={!onClearHistory}
          operation={clearStatus.kind === 'pending' ? { phase: 'pending' } : undefined}
          onConfirm={handleClearConfirm}
        />
        {clearStatus.kind === 'success' && (
          <div className={css.statusRow} role="status">
            {clearStatus.text}
          </div>
        )}
        {clearStatus.kind === 'error' && (
          <div className={css.errorRow} role="alert">
            <span>{clearStatus.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}
