import type { SenseState } from '@asi/sense-types';
import type { DetailUnit, MetricKey, SenseEvent, SensePanelModel, SenseRule, TuningState } from '@asi/sense-ui/model';
import type { createSenseRuntime, EventEntry } from '../runtime/index.ts';
import { type SuggestionUnit, suggestionMetric, suggestionUnit } from './units.ts';

export type Runtime = ReturnType<typeof createSenseRuntime>;
type Suggestion = {
  id: string;
  metric: MetricKey;
  slotLabel: string;
  from: number;
  to: number;
  unit: SuggestionUnit;
  samples: number;
  dates: number;
};
export type PresenterModel = Omit<SensePanelModel, 'tuning'> & {
  tuning: Omit<TuningState, 'log'> & {
    log: (TuningState['log'][number] & {
      status: 'undoable' | 'reverted' | 'superseded' | 'rejected' | 'other';
      undoable: boolean;
    })[];
    suggestions: Suggestion[];
  };
};

const displayValue = (value: number | string | boolean): number | string =>
  typeof value === 'boolean' ? String(value) : value;

export function projectState(state: SenseState): SensePanelModel['state'] {
  return {
    ...state,
    env: {
      ...state.env,
      activeJobs: {
        ...state.env.activeJobs,
        value: state.env.activeJobs.value?.map((job) => ({ ...job, name: job.command ?? job.id })) ?? null,
      },
    },
  };
}

export function projectRules(runtime: Runtime, time: (key: string, at: number) => number): SenseRule[] {
  return runtime.rules.list().map((rule) => ({
    ...rule,
    name: rule.id,
    enabled: runtime.rules.isEnabled(rule.id),
    confirmed: rule.approved,
    ...(rule.expiresAt === undefined ? {} : { expiresAt: time(`rule:${rule.id}`, rule.expiresAt) }),
  }));
}

function detailUnit(metric: string): DetailUnit {
  if (metric.startsWith('disk:') || metric === 'rss') return 'bytes';
  if (metric === 'context') return 'tokens';
  if (metric.startsWith('network.')) return 'bytes/s';
  if (metric === 'battery' || metric === 'thermal') return 'count';
  return 'ratio';
}

function eventDetail(entry: EventEntry): SenseEvent['detail'] {
  const d = entry.detail;
  if (!d) return undefined;
  if (
    entry.kind === 'body.rate' &&
    typeof d.metric === 'string' &&
    typeof d.windowMs === 'number' &&
    typeof d.delta === 'number'
  ) {
    return {
      kind: 'body.rate',
      metric: suggestionMetric(d.metric) ?? d.metric,
      windowMs: d.windowMs,
      delta: d.delta,
      unit: detailUnit(d.metric),
      ...(typeof d.timeToFloorMs === 'number' ? { timeToFloorMs: d.timeToFloorMs } : {}),
    };
  }
  if (
    entry.kind === 'body.anomaly' &&
    typeof d.metric === 'string' &&
    typeof d.value === 'number' &&
    typeof d.baseline === 'number' &&
    typeof d.deviation === 'number'
  ) {
    return {
      kind: 'body.anomaly',
      metric: suggestionMetric(d.metric) ?? d.metric,
      current: d.value,
      baseline: d.baseline,
      deviation: d.deviation,
      unit: detailUnit(d.metric),
    };
  }
  if (
    entry.kind === 'file.burst' &&
    typeof d.directory === 'string' &&
    typeof d.windowMs === 'number' &&
    typeof d.created === 'number' &&
    typeof d.modified === 'number' &&
    typeof d.deleted === 'number'
  ) {
    return {
      kind: 'file.burst',
      directory: d.directory,
      windowMs: d.windowMs,
      created: d.created,
      modified: d.modified,
      deleted: d.deleted,
      excessiveDeletion: d.externalDeletionExceeded === true,
      ...(d.rolledUp === true ? { rolledUp: true } : {}),
    };
  }
  if (
    entry.kind === 'file.activity' &&
    typeof d.directory === 'string' &&
    typeof d.windowMs === 'number' &&
    typeof d.created === 'number' &&
    typeof d.modified === 'number' &&
    typeof d.deleted === 'number'
  ) {
    const files = Array.isArray(d.files)
      ? d.files.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 5)
      : typeof d.files === 'string' && d.files.length > 0
        ? d.files.split(', ').filter(Boolean).slice(0, 5)
        : [];
    return {
      kind: 'file.activity',
      directory: d.directory,
      windowMs: d.windowMs,
      created: d.created,
      modified: d.modified,
      deleted: d.deleted,
      files,
      ...(typeof d.rolledUp === 'number' && d.rolledUp > 0 ? { rolledUp: d.rolledUp } : {}),
      ...(d.degraded === true ? { degraded: true } : {}),
    };
  }
  return undefined;
}

export function projectEvents(
  entries: EventEntry[],
  sendTitles: boolean,
  at: (mono: number) => number,
  fromWall: (wall: number) => number,
): SenseEvent[] {
  return entries.slice(-200).map((entry) => {
    const hidden = !sendTitles && entry.kind.startsWith('window');
    const detail = hidden ? undefined : eventDetail(entry);
    const evidenceAt =
      entry.kind !== 'body.rate'
        ? undefined
        : typeof entry.detail?.evidenceMono === 'number'
          ? at(entry.detail.evidenceMono)
          : typeof entry.detail?.evidenceAt === 'number'
            ? fromWall(entry.detail.evidenceAt)
            : undefined;
    return {
      signal: {
        id: entry.id,
        kind: entry.kind,
        at: entry.mono === undefined ? fromWall(entry.at) : at(entry.mono),
        source: entry.source,
        subject: hidden ? '' : entry.subject,
        data: {
          ...(evidenceAt === undefined ? {} : { evidenceAt }),
          ...(entry.feedbackAvailable === undefined ? {} : { feedbackAvailable: entry.feedbackAvailable }),
        },
      },
      level:
        entry.reason === 'wake-budget' || entry.reason === 'no-session' || entry.reason === 'self-caused'
          ? 'suppressed'
          : entry.level,
      reason: hidden ? '' : (entry.reason ?? ''),
      cause: entry.cause ?? 'unknown',
      ...(!hidden && entry.ruleId ? { ruleName: entry.ruleId } : {}),
      ...(detail ? { detail } : {}),
      ...(entry.feedback ? { feedback: entry.feedback } : {}),
    };
  });
}

export function projectTuning(runtime: Runtime, time: (key: string, at: number) => number): PresenterModel['tuning'] {
  const { tuner, monitor } = runtime.body;
  const undoable = new Set(tuner.undoableChanges.map((entry) => entry.id));
  const logs = tuner.logs;
  const reverted = new Set(
    logs
      .filter(
        (entry) => entry.status === 'applied' && entry.operation === 'revert' && entry.reason.startsWith('revert '),
      )
      .map((entry) => entry.reason.slice('revert '.length)),
  );
  const disabled = tuner.tuningDisabled ?? monitor.tuningDisabled;
  const suggestions = monitor.rebaselineSuggestions.flatMap((item) => {
    const metric = suggestionMetric(item.metric);
    if (!metric || item.slot < 0 || item.slot >= 168) return [];
    const day = ['日', '一', '二', '三', '四', '五', '六'][Math.floor(item.slot / 24)];
    return [
      {
        id: item.id,
        metric,
        slotLabel: `周${day} ${item.slot % 24} 时`,
        from: item.from,
        to: item.to,
        unit: suggestionUnit(metric),
        samples: item.samples,
        dates: item.dates,
      },
    ];
  });
  return {
    parameters: tuner.parameters().map((param) => ({
      key: param.key,
      label: param.key,
      value: displayValue(param.value),
      locked: param.locked,
      source: param.source,
    })),
    log: logs.map((entry) => {
      const canUndo = undoable.has(entry.id);
      const status =
        entry.status === 'rejected'
          ? 'rejected'
          : reverted.has(entry.id)
            ? 'reverted'
            : canUndo
              ? 'undoable'
              : entry.operation === 'propose' || entry.operation === 'revert'
                ? tuner.isLatestApplied(entry)
                  ? 'other'
                  : 'superseded'
                : 'other';
      const suffix =
        status === 'rejected'
          ? `已拒绝: ${entry.rejectionReason ?? 'rejected'}`
          : status === 'superseded'
            ? '已被覆盖，不可撤销'
            : status === 'other'
              ? '不可撤销'
              : undefined;
      return {
        id: entry.id,
        paramKey: entry.param,
        previous: displayValue(entry.from),
        next: displayValue(entry.to),
        by: entry.by,
        at: time(`tuning:${entry.id}`, entry.at),
        reason: suffix ? `${entry.reason} (${suffix})` : entry.reason,
        status,
        undoable: canUndo,
        reverted: status === 'reverted',
      };
    }),
    ...(disabled ? { disabled: { reason: disabled } } : {}),
    ...(monitor.backupError ? { backupError: monitor.backupError } : {}),
    ...(monitor.backupNotice ? { backupNotice: monitor.backupNotice } : {}),
    ...(monitor.restoreKind ? { restoreKind: monitor.restoreKind } : {}),
    suggestions,
  };
}
