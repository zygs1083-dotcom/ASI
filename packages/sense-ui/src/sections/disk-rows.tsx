/**
 * 磁盘卡片：默认只显示「需要注意的盘」（最差剩余比例），
 * 其余挂载点在明细里逐个展开，各自着色、不再重复行级标签。
 * 每卷可带 status/observedAt/ttlMs（diskFact 按状态投影）；
 * unavailableMounts 的挂载点只显示「无法读取」，无数字、无历史、无图。
 */

import { DisksStatusText, FactStatusText } from '../fact';
import { formatBytes, formatPercent, formatSignedDelta } from '../format';
import {
  diskFact,
  diskSeverity,
  diskUsable,
  diskValid,
  effectiveStatus,
  type Severity,
  unavailableMountSet,
} from '../health';
import { DiskIcon } from '../icons';
import { Sparkline } from '../sparkline';
import { chartThresholds } from '../thresholds';
import type { DiskVolume, MetricPoint } from '../view-model';
import css from './body.module.css';
import { DisksDetail } from './disks-detail';
import { type DetailMetric, Tile } from './tile';
import { type MetricTileProps, memoTile } from './tiles-basic';

type Disk = DiskVolume;

const SEV_RANK: Record<Severity, number> = {
  good: 0,
  unknown: 0,
  warn: 1,
  critical: 2,
};

/** 从最近 5 分钟 diskFree 趋势环计算显著骤降徽标（≤ −100 MB/分时显示）。 */
export function diskDropRateBadge(points: MetricPoint[] | undefined, now: number): string | undefined {
  if (!points || points.length < 2) return undefined;
  const recent = points.filter(
    (p) => Number.isFinite(p.at) && Number.isFinite(p.value) && p.at >= now - 300_000 && p.at <= now,
  );
  if (recent.length < 2) return undefined;
  const first = recent[0]!;
  const last = recent[recent.length - 1]!;
  const dtMs = last.at - first.at;
  if (dtMs < 30_000) return undefined;
  const perMin = (last.value - first.value) / (dtMs / 60_000);
  if (!Number.isFinite(perMin) || perMin > -100 * 1024 * 1024) return undefined;
  return `${formatSignedDelta(perMin, 'bytes')}/分`;
}

function diskSev(d: Disk): Severity {
  const freeRatio = d.total > 0 ? d.free / d.total : 0;
  return diskSeverity(freeRatio);
}

/** 需要注意的盘：严重度最高者优先，同级取剩余比例最低。 */
function attentionDisk(disks: Disk[]): Disk {
  return disks.reduce((best, d) => {
    const sevD = SEV_RANK[diskSev(d)];
    const sevB = SEV_RANK[diskSev(best)];
    if (sevD !== sevB) return sevD > sevB ? d : best;
    const ratio = (x: Disk) => (x.total > 0 ? x.free / x.total : 0);
    return ratio(d) < ratio(best) ? d : best;
  });
}

/** 剩余比例条：填充宽度 = free/total（剩余量），不是已用占比。 */
function FreeStrip({ d, label }: { d: Disk; label?: boolean }) {
  const remaining = d.total > 0 ? Math.min(1, Math.max(0, d.free / d.total)) : 0;
  return (
    <span className={css.stripWrap}>
      {label ? <span className={css.stripText}>剩余</span> : null}
      <span className={css.memStrip} aria-hidden="true">
        <i
          className={css.diskUsed}
          data-strip="remaining"
          data-ratio={remaining}
          style={{ width: `${remaining * 100}%` }}
        />
      </span>
    </span>
  );
}

export const DisksTile = memoTile(
  'disks',
  (m) => [m.state.self.body.disks, m.history.disks, m.history.diskFree],
  function DisksTile({ model, rows, ctx }: MetricTileProps) {
    const { disks } = model.state.self.body;
    const { now } = model;
    const unavail = unavailableMountSet(disks);
    const raw = disks.value ?? [];
    const usable = (d: Disk): boolean => diskUsable(disks, d, now);

    const entries: Disk[] = [
      ...(raw ?? []).filter(
        (d) => diskValid(d) || unavail.has(d.mount) || d.status != null || d.observedAt != null || d.ttlMs != null,
      ),
      ...[...unavail]
        .filter((m) => !(raw ?? []).some((d) => d.mount === m))
        .map((m) => ({ mount: m, total: 0, free: 0 })),
    ];
    const freshVols = entries.filter(usable);
    const worstFresh = freshVols.length ? attentionDisk(freshVols) : null;
    const alert = worstFresh && SEV_RANK[diskSev(worstFresh)] > 0 ? worstFresh : null;
    const root = entries.find((d) => d.mount === '/');
    const focus = alert ?? (root && !usable(root) ? root : null) ?? worstFresh ?? entries[0] ?? null;
    const sev = (d: Disk): Severity => (usable(d) ? diskSev(d) : 'unknown');
    const focusDf = focus && diskValid(focus) && !unavail.has(focus.mount) ? diskFact(disks, focus, now) : null;
    const focusEff = focusDf ? effectiveStatus(focusDf, now) : null;
    const focusUsable = focus != null && usable(focus);

    const metrics: DetailMetric[] = entries
      .filter((d) => {
        if (unavail.has(d.mount) || !diskValid(d)) return false;
        const s = effectiveStatus(diskFact(disks, d, now), now);
        return s === 'ok' || s === 'stale';
      })
      .map((d) => {
        const key = `disk:${d.mount}` as const;
        const u = usable(d);
        return {
          key,
          label: `磁盘 ${d.mount} 已用率`,
          points: model.history.disks[d.mount] ?? [],
          format: formatPercent,
          valueText: `剩余 ${formatBytes(d.free)} / ${formatBytes(d.total)}`,
          badge: u ? diskDropRateBadge(model.history.diskFree?.[d.mount], now) : undefined,
          severity: sev(d),
          fact: diskFact(disks, d, now),
        };
      });

    return (
      <Tile
        tileKey="disks"
        icon={<DiskIcon />}
        label="磁盘"
        sev={rows.disks.severity}
        detail={
          <DisksDetail
            disks={disks}
            now={now}
            onOpenPermissionSettings={ctx.onOpenPermissionSettings}
            metrics={metrics}
            extra={entries.map((d) => {
              if (unavail.has(d.mount)) {
                return (
                  <div key={d.mount} className={css.detailLine} data-sev="unknown">
                    {d.mount} 无法读取
                  </div>
                );
              }
              return (
                <div key={d.mount} className={css.detailLine} data-sev={sev(d)}>
                  {d.mount}{' '}
                  <FactStatusText fact={diskFact(disks, d, now)} now={now}>
                    {(v) => <FreeStrip d={v} label />}
                  </FactStatusText>
                </div>
              );
            })}
          />
        }
      >
        {rows.disks.partial ? (
          <span className={css.tileSub} data-partial>
            部分 · 数据待补全
          </span>
        ) : null}
        {focus == null ? (
          <DisksStatusText fact={disks} now={now}>
            {() => <span className={css.tileSub}>无有效磁盘读数</span>}
          </DisksStatusText>
        ) : unavail.has(focus.mount) || !diskValid(focus) ? (
          <span className={css.tileSub}>
            {focus.mount} {unavail.has(focus.mount) ? '无法读取' : '· 未知'}
          </span>
        ) : focusEff !== 'ok' && focusEff !== 'stale' ? (
          <span className={css.tileSub}>
            {focus.mount} ·{' '}
            <FactStatusText fact={focusDf!} now={now}>
              {() => null}
            </FactStatusText>
          </span>
        ) : (
          <FactStatusText fact={focusDf!} now={now}>
            {(d) => {
              const badge = focusUsable ? diskDropRateBadge(model.history.diskFree?.[d.mount], now) : undefined;
              return (
                <>
                  <span className={css.tileValue}>
                    <span className={css.mainLabel}>剩余</span>
                    {formatBytes(d.free)}
                  </span>
                  <span className={css.tileSub}>
                    共 {formatBytes(d.total)} · {d.mount}
                    {entries.length > 1 ? ` · 共 ${entries.length} 盘` : ''}
                    {badge ? <em className={css.rateEm}>{badge}</em> : null}
                  </span>
                  <FreeStrip d={d} />
                  <Sparkline
                    metric={`disk:${d.mount}`}
                    points={model.history.disks[d.mount] ?? []}
                    now={now}
                    label={`磁盘 ${d.mount} 已用率`}
                    format={formatPercent}
                    severity={sev(focus)}
                    thresholds={focusUsable ? chartThresholds(`disk:${d.mount}`).lines : []}
                  />
                </>
              );
            }}
          </FactStatusText>
        )}
      </Tile>
    );
  },
);
