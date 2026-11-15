/** 网络 / DSH 进程 指标卡片：主图各取 Rx 与 RSS，另一路进明细。 */

import { FactStatusText } from '../fact'
import { formatBytes, formatDuration, formatPercent, formatRate } from '../format'
import { isUsable } from '../health'
import { Sparkline } from '../sparkline'
import { chartThresholds } from '../thresholds'
import { NetworkIcon, ProcessIcon } from '../icons'
import type { TileCtx } from './tiles-basic'
import { Tile, TileDetail } from './tile'
import css from './body.module.css'

type Rows = ReturnType<typeof import('../health').evaluateBody>['rows']

export function NetworkTile({ model, rows, ctx }: { model: TileCtx['model']; rows: Rows; ctx: TileCtx }) {
  const { network } = model.state.self.body
  const { now, insights } = model
  const v = isUsable(network, now) ? network.value! : null
  const rxThr = chartThresholds('networkRx', insights?.networkRx)
  return (
    <Tile
      tileKey="network"
      icon={<NetworkIcon />}
      label="网络"
      sev={rows.network.severity}
      detail={
        <TileDetail
          fact={network}
          now={now}
          events={model.events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={[
            {
              key: 'networkRx',
              label: '网络下行',
              points: model.history.networkRx,
              format: formatRate,
              valueText: v ? formatRate(v.rxBps) : undefined,
              insight: insights?.networkRx,
              severity: rows.network.severity,
            },
            {
              key: 'networkTx',
              label: '网络上行',
              points: model.history.networkTx,
              format: formatRate,
              valueText: v ? formatRate(v.txBps) : undefined,
              insight: insights?.networkTx,
              severity: rows.network.severity,
            },
          ]}
        />
      }
    >
      <FactStatusText fact={network} now={now}>
        {(val) => (
          <>
            <span className={css.tileValue}>↓ {formatRate(val.rxBps)}</span>
            <span className={css.tileSub}>
              ↑ {formatRate(val.txBps)} · {val.online ? '已连接' : '已断开'}
            </span>
            <Sparkline
              points={model.history.networkRx}
              now={now}
              label="网络下行"
              format={formatRate}
              severity={rows.network.severity}
              baseline={insights?.networkRx?.baseline}
              thresholds={rxThr.lines}
            />
          </>
        )}
      </FactStatusText>
    </Tile>
  )
}

export function ProcessTile({ model, rows, ctx }: { model: TileCtx['model']; rows: Rows; ctx: TileCtx }) {
  const { harnessProcess } = model.state.self.body
  const { now, insights } = model
  const v = isUsable(harnessProcess, now) ? harnessProcess.value! : null
  const rssThr = chartThresholds('processRss', insights?.processRss)
  return (
    <Tile
      tileKey="process"
      icon={<ProcessIcon />}
      label="DSH 进程"
      sev={rows.process.severity}
      detail={
        <TileDetail
          fact={harnessProcess}
          now={now}
          events={model.events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={[
            {
              key: 'processRss',
              label: 'DSH 内存',
              points: model.history.processRss,
              format: formatBytes,
              valueText: v ? formatBytes(v.rss) : undefined,
              insight: insights?.processRss,
              severity: rows.process.severity,
            },
            {
              key: 'processCpu',
              label: 'DSH CPU',
              points: model.history.processCpu,
              format: formatPercent,
              valueText: v ? formatPercent(v.cpu) : undefined,
              insight: insights?.processCpu,
              severity: rows.process.severity,
            },
          ]}
          extra={
            v && <div className={css.detailLine}>已运行 {formatDuration(v.uptimeSec)}</div>
          }
        />
      }
    >
      <FactStatusText fact={harnessProcess} now={now}>
        {(val) => (
          <>
            <span className={css.tileValue}>{formatBytes(val.rss)}</span>
            <span className={css.tileSub}>CPU {formatPercent(val.cpu)}</span>
            <Sparkline
              points={model.history.processRss}
              now={now}
              label="DSH 内存"
              format={formatBytes}
              severity={rows.process.severity}
              baseline={insights?.processRss?.baseline}
              thresholds={rssThr.lines}
            />
          </>
        )}
      </FactStatusText>
    </Tile>
  )
}
