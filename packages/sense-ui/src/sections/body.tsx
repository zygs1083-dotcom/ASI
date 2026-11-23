import { useMemo } from 'react';
import { ClockProvider, SamplingProvider } from '../clock';
import { evaluateBody, type Severity } from '../health';
import type { NeedsPanelProps } from '../view-model';
import css from './body.module.css';
import { DisksTile } from './disk-rows';
import mcss from './monitor.module.css';
import { CpuTile, MemoryTile, type TileCtx } from './tiles-basic';
import { BatteryTile, ThermalTile } from './tiles-extra';
import { NetworkTile, ProcessTile } from './tiles-net-proc';
import { TokenTile } from './token-row';

type Panel = Pick<NeedsPanelProps, 'model' | 'onOpenPermissionSettings'>;

const SEV_WORD = {
  good: '良好',
  warn: '注意',
  critical: '紧急',
  unknown: '未知',
} as const;

/** ECG 心电线：底色为基线，脉冲段按严重度不同周期流动（reduced-motion 时静止）。 */
function Ecg() {
  const d = 'M0 12h14l4-8 6 16 5-14 3 6h28';
  return (
    <svg className={mcss.ecg} viewBox="0 0 60 24" aria-hidden="true">
      <path className={mcss.ecgBase} d={d} />
      <path className={mcss.ecgPulse} d={d} />
    </svg>
  );
}

/** 监护概览：大写严重度词 + 状态句。读数不完整时词旁另出「部分」徽标。 */
function Monitor({ sev, sentence, partial }: { sev: Severity; sentence: string; partial?: boolean }) {
  return (
    <div className={mcss.monitor} data-sev={sev}>
      <Ecg />
      <div className={mcss.monitorText}>
        <strong className={mcss.monitorWord}>
          {SEV_WORD[sev]}
          {partial ? <span className={mcss.monitorPartial}>部分</span> : null}
        </strong>
        <span className={mcss.monitorSub}>{sentence}</span>
      </div>
    </div>
  );
}

export function BodySection({ model, onOpenPermissionSettings }: Panel) {
  const { body } = model.state.self;
  const { now } = model;
  const evalResult = evaluateBody(body, now);
  const rows = evalResult.rows;
  const ctx: TileCtx = {
    model,
    onOpenPermissionSettings,
  };
  const sampling = useMemo(
    () => ({ paused: model.paused, intervals: model.sampleIntervalsMs }),
    [model.paused, model.sampleIntervalsMs],
  );

  return (
    <>
      <Monitor sev={evalResult.severity} sentence={evalResult.sentence} partial={evalResult.partial} />
      <ClockProvider value={now}>
        <SamplingProvider value={sampling}>
          <div className={css.tiles}>
            <CpuTile model={model} rows={rows} ctx={ctx} />
            <MemoryTile model={model} rows={rows} ctx={ctx} />
            <TokenTile model={model} rows={rows} ctx={ctx} />
            <DisksTile model={model} rows={rows} ctx={ctx} />
            <NetworkTile model={model} rows={rows} ctx={ctx} />
            <ThermalTile model={model} rows={rows} ctx={ctx} />
            {!rows.battery.hidden && <BatteryTile model={model} rows={rows} ctx={ctx} />}
            <ProcessTile model={model} rows={rows} ctx={ctx} />
          </div>
        </SamplingProvider>
      </ClockProvider>
    </>
  );
}
