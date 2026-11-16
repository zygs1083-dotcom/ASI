/** 温控 / 电池 指标卡片。 */

import { FactStatusText } from '../fact'
import {
  formatDuration,
  formatPercentValue,
  formatThermalOrdinal,
} from '../format'
import { isUsable } from '../health'
import { Sparkline } from '../sparkline'
import { chartThresholds } from '../thresholds'
import { BatteryIcon, ThermalIcon } from '../icons'
import { Tile, TileDetail } from './tile'
import { memoTile, type MetricTileProps } from './tiles-basic'
import css from './body.module.css'

const THERMAL_TEXT = {
  nominal: '正常',
  fair: '偏高',
  serious: '偏高',
  critical: '过热',
} as const

export const ThermalTile = memoTile(
  'thermal',
  (m) => [m.state.self.body.thermal, m.insights?.thermal, m.history.thermal],
  function ThermalTile({ model, rows, ctx }: MetricTileProps) {
  const { thermal } = model.state.self.body
  const { now } = model
  const fresh = isUsable(thermal, now)
  const v = fresh ? thermal.value! : null
  const thr = fresh ? chartThresholds('thermal', model.insights?.thermal) : { lines: [] }
  return (
    <Tile
      tileKey="thermal"
      icon={<ThermalIcon />}
      label="温控"
      sev={rows.thermal.severity}
      detail={
        <TileDetail
          fact={thermal}
          now={now}
          events={model.events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={[
            {
              key: 'thermal',
              label: '温控档位',
              points: model.history.thermal,
              format: formatThermalOrdinal,
              valueText: thermal.value ? THERMAL_TEXT[thermal.value] : undefined,
              insight: model.insights?.thermal,
              severity: rows.thermal.severity,
            },
          ]}
        />
      }
    >
      <FactStatusText fact={thermal} now={now}>
        {(val) => (
          <>
            <span className={css.tileValue}>{THERMAL_TEXT[val]}</span>
            <span className={css.tileSub}>温控档位</span>
            <Sparkline
              metric="thermal"
              points={model.history.thermal}
              now={now}
              label="温控档位"
              format={formatThermalOrdinal}
              severity={rows.thermal.severity}
              baseline={fresh ? model.insights?.thermal?.baseline : undefined}
              thresholds={thr.lines}
            />
          </>
        )}
      </FactStatusText>
    </Tile>
  )
})

export const BatteryTile = memoTile(
  'battery',
  (m) => [m.state.self.body.battery, m.insights?.battery, m.history.battery],
  function BatteryTile({ model, rows, ctx }: MetricTileProps) {
  const { battery } = model.state.self.body
  const { now } = model
  const fresh = isUsable(battery, now)
  const v = fresh ? battery.value : null
  const thr = fresh ? chartThresholds('battery', model.insights?.battery) : { lines: [] }
  return (
    <Tile
      tileKey="battery"
      icon={<BatteryIcon />}
      label="电池"
      sev={rows.battery.severity}
      detail={
        <TileDetail
          fact={battery}
          now={now}
          events={model.events}
          onAdjust={ctx.onAdjust}
          onOpenPermissionSettings={ctx.onOpenPermissionSettings}
          metrics={[
            {
              key: 'battery',
              label: '电池电量',
              points: model.history.battery,
              format: formatPercentValue,
              valueText: battery.value
                ? formatPercentValue(battery.value.percent)
                : undefined,
              insight: model.insights?.battery,
              severity: rows.battery.severity,
            },
          ]}
        />
      }
    >
      <FactStatusText fact={battery} now={now}>
        {(val) =>
          val && (
            <>
              <span className={css.tileValue}>{formatPercentValue(val.percent)}</span>
              <span className={css.tileSub}>
                {val.charging ? '充电中' : '未充电'}
                {fresh && val.minutesLeft != null
                  ? ` · 约剩 ${formatDuration(val.minutesLeft * 60)}`
                  : ''}
              </span>
              <Sparkline
                metric="battery"
                points={model.history.battery}
                now={now}
                label="电池电量"
                format={formatPercentValue}
                severity={rows.battery.severity}
                baseline={fresh ? model.insights?.battery?.baseline : undefined}
                thresholds={thr.lines}
              />
            </>
          )
        }
      </FactStatusText>
    </Tile>
  )
})
