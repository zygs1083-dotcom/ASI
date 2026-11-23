import { formatPercentValue } from '../format';
import { type DriveEvaluation, NEED_KEYS, type NeedEvaluation, type NeedKey, type NeedZone } from '../view-model';
import { NEED_LABEL } from './help-cards';
import css from './needs.module.css';

const ZONE_WORD: Record<NeedZone, string> = {
  comfortable: '舒适',
  uncomfortable: '不适',
  critical: '危急',
};

const BANNER_TEXT: Record<NeedZone, string> = {
  comfortable: '稳态舒适',
  uncomfortable: '存在不适 · 正在自发维护',
  critical: '生存危急 · 自救与求助中',
};

export function NeedsSection({
  needs,
  overallZone,
  higherOrderDrives,
  higherOrderSuppressed,
  higherOrderSuppressionReason,
}: {
  needs: Record<NeedKey, NeedEvaluation>;
  overallZone: NeedZone;
  higherOrderDrives?: DriveEvaluation[];
  higherOrderSuppressed?: boolean;
  higherOrderSuppressionReason?: string;
}) {
  const activeDrives = NEED_KEYS.filter((k) => needs[k].driveActive);
  const extraDrives = higherOrderDrives ?? [];

  return (
    <>
      <div className={css.homeostasisBanner} data-overall-zone={overallZone}>
        <span className={css.bannerStatus} data-zone={overallZone}>
          {activeDrives.length > 0 && overallZone === 'comfortable'
            ? '稳态恢复中（回滞保持）'
            : BANNER_TEXT[overallZone]}
        </span>
        <span className={css.bannerMeta}>
          {activeDrives.length > 0 ? `${activeDrives.length} 项驱动激活` : '无未满足驱动力'}
        </span>
      </div>

      <div className={css.needList}>
        {NEED_KEYS.map((key) => {
          const item = needs[key];
          const sat = Math.max(0, Math.min(100, Math.round(item.satisfaction)));
          const urg = Math.max(0, Math.min(100, Math.round(item.urgency)));
          const visualZone: NeedZone = item.zone === 'comfortable' && item.driveActive ? 'uncomfortable' : item.zone;
          return (
            <div key={key} className={css.needCard} data-need={key} data-zone={item.zone}>
              <div className={css.needHead}>
                <span className={css.needTitleWrap}>
                  <span className={css.needName}>{item.label || NEED_LABEL[key]}</span>
                  <span className={css.zoneBadge} data-zone={item.zone}>
                    {ZONE_WORD[item.zone]}
                  </span>
                  {item.driveActive && (
                    <span className={css.driveBadge}>
                      {item.zone === 'comfortable' ? '恢复至 70% 前保持驱动' : '自维护驱动中'}
                    </span>
                  )}
                </span>
                <span className={css.needScore}>
                  满足 {formatPercentValue(sat)} · 紧迫 {formatPercentValue(urg)}
                </span>
              </div>
              <div className={css.meterTrack} aria-hidden="true">
                <i className={css.meterFill} data-zone={visualZone} style={{ width: `${sat}%` }} />
              </div>
              <div className={css.needSummary}>{item.summary}</div>
            </div>
          );
        })}
      </div>

      {extraDrives.length > 0 && (
        <div className={css.higherBlock} data-higher-drives>
          <div className={css.higherHead}>
            <span className={css.higherTitle}>高阶需求仲裁（ctx.asiDrives）</span>
            {higherOrderSuppressed && (
              <span className={css.suppressedBadge}>
                {higherOrderSuppressionReason ?? '已挂起（优先保障 L1 生理稳态）'}
              </span>
            )}
          </div>
          <div className={css.needList}>
            {extraDrives.map((drv) => {
              const sat = Math.max(0, Math.min(100, Math.round(drv.satisfaction)));
              const urg = Math.max(0, Math.min(100, Math.round(drv.urgency)));
              return (
                <div
                  key={drv.key}
                  className={css.needCard}
                  data-drive={drv.key}
                  data-zone={drv.zone}
                  data-suppressed={drv.suppressed ? 'true' : 'false'}
                >
                  <div className={css.needHead}>
                    <span className={css.needTitleWrap}>
                      <span className={css.tierTag}>{`L${drv.tier}`}</span>
                      <span className={css.needName}>{drv.label}</span>
                      <span className={css.zoneBadge} data-zone={drv.zone}>
                        {ZONE_WORD[drv.zone]}
                      </span>
                      {drv.suppressed ? (
                        <span className={css.suppressedInline}>已压制挂起</span>
                      ) : drv.driveActive ? (
                        <span className={css.driveBadge}>自维护驱动中</span>
                      ) : null}
                    </span>
                    <span className={css.needScore}>
                      满足 {formatPercentValue(sat)} · 紧迫 {formatPercentValue(urg)}
                    </span>
                  </div>
                  <div className={css.meterTrack} aria-hidden="true">
                    <i className={css.meterFill} data-zone={drv.zone} style={{ width: `${sat}%` }} />
                  </div>
                  <div className={css.needSummary}>{drv.summary}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
