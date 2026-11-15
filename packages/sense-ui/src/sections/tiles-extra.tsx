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
import type { TileCtx } from './tiles-basic'
import css from './body.module.css'

type Rows = ReturnType<typeof import('../health').evaluateBody>['rows']

const THERMAL_TEXT = {
  nominal: '正常',
  fair: '偏高',
  serious: '偏高',
  critical: '过热',
} as const

export function ThermalTile({ model, rows, ctx }: { model: TileCtx['model']; rows: Rows; ctx: TileCtx }) {
  const { thermal } = model.state.self.body
  const { now } = model
  const v = isUsable(thermal, now) ? thermal.value! : null
  const thr = chartThresholds('thermal', model.insights?.thermal)
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
              valueText: v ? THERMAL_TEXT[v] : undefined,
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
              points={model.history.thermal}
              now={now}
              label="温控档位"
              format={formatThermalOrdinal}
              severity={rows.thermal.severity}
              baseline={model.insights?.thermal?.baseline}
              thresholds={thr.lines}
            />
          </>
        )}
      </FactStatusText>
    </Tile>
  )
}

export function BatteryTile({ model, rows, ctx }: { model: TileCtx['model']; rows: Rows; ctx: TileCtx }) {
  const { battery } = model.state.self.body
  const { now } = model
  const v = isUsable(battery, now) ? battery.value : null
  const thr = chartThresholds('battery', model.insights?.battery)
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
              valueText: v ? formatPercentValue(v.percent) : undefined,
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
                {val.minutesLeft != null
                  ? ` · 约剩 ${formatDuration(val.minutesLeft * 60)}`
                  : ''}
              </span>
              <Sparkline
                points={model.history.battery}
                now={now}
                label="电池电量"
                format={formatPercentValue}
                severity={rows.battery.severity}
                baseline={model.insights?.battery?.baseline}
                thresholds={thr.lines}
              />
            </>
          )
        }
      </FactStatusText>
    </Tile>
  )
}
