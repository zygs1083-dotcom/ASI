/** CPU / 内存 指标卡片（温控/电池见 tiles-extra）。 */

import { FactStatusText } from '../fact'
import {
  formatBytes,
  formatLoad,
  formatPercent,
} from '../format'
import { isUsable } from '../health'
import { Sparkline } from '../sparkline'
import { chartThresholds } from '../thresholds'
import { CpuIcon, MemoryIcon } from '../icons'
import type { SensePanelProps } from '../view-model'
import { Tile, TileDetail } from './tile'
import css from './body.module.css'

export interface TileCtx {
  model: SensePanelProps['model']
  onAdjust?: () => void
  onOpenPermissionSettings: () => void
}

type Rows = ReturnType<typeof import('../health').evaluateBody>['rows']

const PRESSURE_TEXT = {
  normal: '压力正常',
  warn: '压力偏高',
  critical: '压力过载',
} as const

const MEM_PARTS = [
  { key: 'app', label: 'App', cls: css.memApp },
  { key: 'wired', label: '联动', cls: css.memWired },
  { key: 'compressed', label: '压缩', cls: css.memCompressed },
  { key: 'cached', label: '缓存', cls: css.memCached },
] as const

export function CpuTile({ model, rows, ctx }: { model: TileCtx['model']; rows: Rows; ctx: TileCtx }) {
  const { cpu } = model.state.self.body
  const { now } = model
  const v = isUsable(cpu, now) ? cpu.value! : null
  const thr = chartThresholds('cpu', model.insights?.cpu)
  return (
    <Tile
      tileKey="cpu"
      icon={<CpuIcon />}
      label="CPU"
      sev={rows.cpu.severity}
      detail={
        <TileDetail
          fact={cpu}
          now={now}
          events={model.events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={[
            {
              key: 'cpu',
              label: 'CPU 使用率',
              points: model.history.cpu,
              format: formatPercent,
              valueText: v ? formatPercent(v.usage) : undefined,
              insight: model.insights?.cpu,
              severity: rows.cpu.severity,
            },
          ]}
          extra={
            v && (
              <div className={css.detailLine}>
                负载 {formatLoad(v.load1)} / {formatLoad(v.load5)} /{' '}
                {formatLoad(v.load15)}
              </div>
            )
          }
        />
      }
    >
      <FactStatusText fact={cpu} now={now}>
        {(val) => (
          <>
            <span className={css.tileValue}>{formatPercent(val.usage)}</span>
            <span className={css.tileSub}>
              负载 {formatLoad(val.load1)} / {formatLoad(val.load5)} /{' '}
              {formatLoad(val.load15)}
            </span>
            <Sparkline
              points={model.history.cpu}
              now={now}
              label="CPU 使用率"
              format={formatPercent}
              severity={rows.cpu.severity}
              baseline={model.insights?.cpu?.baseline}
              thresholds={thr.lines}
            />
            <span className={css.cores} aria-hidden="true">
              {val.perCore.map((c, i) => (
                <i key={i} style={{ height: `${Math.round(Math.min(1, Math.max(0, c)) * 100)}%` }} />
              ))}
            </span>
          </>
        )}
      </FactStatusText>
    </Tile>
  )
}

export function MemoryTile({ model, rows, ctx }: { model: TileCtx['model']; rows: Rows; ctx: TileCtx }) {
  const { memory } = model.state.self.body
  const { now } = model
  const v = isUsable(memory, now) ? memory.value! : null
  const thr = chartThresholds('memory', model.insights?.memory)
  return (
    <Tile
      tileKey="memory"
      icon={<MemoryIcon />}
      label="内存"
      sev={rows.memory.severity}
      detail={
        <TileDetail
          fact={memory}
          now={now}
          events={model.events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={[
            {
              key: 'memory',
              label: '内存占用',
              points: model.history.memory,
              format: formatPercent,
              valueText: v ? `${formatBytes(v.used)} / ${formatBytes(v.total)}` : undefined,
              insight: model.insights?.memory,
              severity: rows.memory.severity,
            },
          ]}
          extra={
            <>
              <div className={css.detailLine}>
                {v?.breakdown
                  ? MEM_PARTS.map(
                      (p) => `${p.label} ${formatBytes(v.breakdown![p.key])}`,
                    ).join(' · ')
                  : '内存细分未提供'}
              </div>
              {v && (
                <div className={css.detailLine}>
                  交换 {formatBytes(v.swapUsed)}
                </div>
              )}
            </>
          }
        />
      }
    >
      <FactStatusText fact={memory} now={now}>
        {(val) => (
          <>
            <span className={css.tileValue}>{formatBytes(val.used)}</span>
            <span className={css.tileSub}>
              共 {formatBytes(val.total)} · {PRESSURE_TEXT[val.pressure]}
            </span>
            {val.breakdown ? (
              <span className={css.memStrip} aria-hidden="true">
                {MEM_PARTS.map((p) => (
                  <i
                    key={p.key}
                    className={p.cls}
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(0, (val.breakdown![p.key] / Math.max(1, val.total)) * 100),
                      )}%`,
                    }}
                  />
                ))}
              </span>
            ) : (
              <span className={css.memStrip} aria-hidden="true">
                <i
                  className={css.memApp}
                  style={{
                    width: `${Math.min(100, Math.max(0, (val.used / Math.max(1, val.total)) * 100))}%`,
                  }}
                />
              </span>
            )}
            <Sparkline
              points={model.history.memory}
              now={now}
              label="内存占用"
              format={formatPercent}
              severity={rows.memory.severity}
              baseline={model.insights?.memory?.baseline}
              thresholds={thr.lines}
            />
          </>
        )}
      </FactStatusText>
    </Tile>
  )
}

