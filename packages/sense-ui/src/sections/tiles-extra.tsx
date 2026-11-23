/** 温控 / 电池 指标卡片。 */

import type { Body as SharedBody } from '@asi/sense-types';
import { FactStatusText } from '../fact';
import { formatDuration, formatPercentValue, formatThermalOrdinal } from '../format';
import { isUsable } from '../health';
import { BatteryIcon, ThermalIcon } from '../icons';
import { Sparkline } from '../sparkline';
import { chartThresholds } from '../thresholds';
import css from './body.module.css';
import { Tile, TileDetail } from './tile';
import { type MetricTileProps, memoTile } from './tiles-basic';

const THERMAL_TEXT = {
  nominal: '正常',
  fair: '略高',
  serious: '偏高',
  critical: '过热',
} as const;

export const ThermalTile = memoTile(
  'thermal',
  (m) => [m.state.self.body.thermal, m.history.thermal],
  function ThermalTile({ model, rows, ctx }: MetricTileProps) {
    const { thermal } = model.state.self.body;
    const { now } = model;
    const fresh = isUsable(thermal, now);
    const thr = fresh ? chartThresholds('thermal') : { lines: [] };
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
            onOpenPermissionSettings={ctx.onOpenPermissionSettings}
            metrics={[
              {
                key: 'thermal',
                label: '温控档位',
                points: model.history.thermal,
                format: formatThermalOrdinal,
                valueText: thermal.value ? THERMAL_TEXT[thermal.value] : undefined,
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
                thresholds={thr.lines}
              />
            </>
          )}
        </FactStatusText>
      </Tile>
    );
  },
);

export const BatteryTile = memoTile(
  'battery',
  (m) => [m.state.self.body.battery, m.history.battery],
  function BatteryTile({ model, rows, ctx }: MetricTileProps) {
    const { battery } = model.state.self.body;
    const { now } = model;
    const fresh = isUsable(battery, now);
    const thr = fresh ? chartThresholds('battery') : { lines: [] };
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
            onOpenPermissionSettings={ctx.onOpenPermissionSettings}
            metrics={[
              {
                key: 'battery',
                label: '电池电量',
                points: model.history.battery,
                format: formatPercentValue,
                valueText: battery.value ? formatPercentValue(battery.value.percent) : undefined,
                severity: rows.battery.severity,
              },
            ]}
          />
        }
      >
        <FactStatusText fact={battery} now={now}>
          {(val) => {
            if (!val) return null;
            const b: NonNullable<SharedBody['battery']['value']> = val;
            const estimate =
              fresh && b.minutesLeft != null && Number.isFinite(b.minutesLeft) && b.minutesLeft > 0
                ? formatDuration(b.minutesLeft * 60)
                : null;
            return (
              <>
                <span className={css.tileValue}>{formatPercentValue(val.percent)}</span>
                <span className={css.tileSub}>
                  {b.powerState === 'charged'
                    ? '已充满 · 接通电源'
                    : b.powerState === 'external'
                      ? '未充电 · 接通电源'
                      : b.powerState === 'charging' || (!b.powerState && b.charging)
                        ? '充电中'
                        : '未充电'}
                  {fresh && b.powerState === 'charging'
                    ? estimate
                      ? ` · 约 ${estimate} 后充满`
                      : ' · 估算中'
                    : fresh && b.powerState === 'battery'
                      ? estimate
                        ? ` · 约剩 ${estimate}`
                        : ' · 估算中'
                      : fresh && b.powerState !== 'charged' && b.estimatePending
                        ? ' · 估算中'
                        : ''}
                </span>
                <Sparkline
                  metric="battery"
                  points={model.history.battery}
                  now={now}
                  label="电池电量"
                  format={formatPercentValue}
                  severity={rows.battery.severity}
                  thresholds={thr.lines}
                />
              </>
            );
          }}
        </FactStatusText>
      </Tile>
    );
  },
);
