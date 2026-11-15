/** 网络 / DSH 进程 指标卡片：主图各取 Rx 与 RSS，另一路进明细。 */

import { FactStatusText } from '../fact'
import { formatBytes, formatDuration, formatPercent, formatRate } from '../format'
import { isUsable } from '../health'
import { Sparkline } from '../sparkline'
import { chartThresholds } from '../thresholds'
import { NetworkIcon, ProcessIcon } from '../icons'
import { memoTile, type MetricTileProps } from './tiles-basic'
import { Tile, TileDetail } from './tile'
import css from './body.module.css'

export const NetworkTile = memoTile(
  'network',
  (m) => [
    m.state.self.body.network,
    m.insights?.networkRx,
    m.insights?.networkTx,
    m.history.networkRx,
    m.history.networkTx,
  ],
  function NetworkTile({ model, rows, ctx }: MetricTileProps) {
  const { network } = model.state.self.body
  const { now, insights } = model
  const fresh = isUsable(network, now)
  const v = fresh ? network.value! : null
  const rxThr = fresh ? chartThresholds('networkRx', insights?.networkRx) : { lines: [] }
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
              valueText: network.value ? formatRate(network.value.rxBps) : undefined,
              insight: insights?.networkRx,
              severity: rows.network.severity,
            },
            {
              key: 'networkTx',
              label: '网络上行',
              points: model.history.networkTx,
              format: formatRate,
              valueText: network.value ? formatRate(network.value.txBps) : undefined,
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
              baseline={fresh ? insights?.networkRx?.baseline : undefined}
              thresholds={rxThr.lines}
            />
          </>
        )}
      </FactStatusText>
    </Tile>
  )
})

export const ProcessTile = memoTile(
  'process',
  (m) => [
    m.state.self.body.harnessProcess,
    m.insights?.processCpu,
    m.insights?.processRss,
    m.history.processCpu,
    m.history.processRss,
  ],
  function ProcessTile({ model, rows, ctx }: MetricTileProps) {
  const { harnessProcess } = model.state.self.body
  const { now, insights } = model
  const fresh = isUsable(harnessProcess, now)
  const v = fresh ? harnessProcess.value! : null
  const rssThr = fresh ? chartThresholds('processRss', insights?.processRss) : { lines: [] }
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
              valueText: harnessProcess.value
                ? formatBytes(harnessProcess.value.rss)
                : undefined,
              insight: insights?.processRss,
              severity: rows.process.severity,
            },
            {
              key: 'processCpu',
              label: 'DSH CPU',
              points: model.history.processCpu,
              format: formatPercent,
              valueText: harnessProcess.value
                ? formatPercent(harnessProcess.value.cpu)
                : undefined,
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
              baseline={fresh ? insights?.processRss?.baseline : undefined}
              thresholds={rssThr.lines}
            />
          </>
        )}
      </FactStatusText>
    </Tile>
  )
})
