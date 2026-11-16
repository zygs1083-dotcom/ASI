import type { Signal } from '@asi/sense-types';
import type { EventEntry } from './attention.ts';

const detailFields: Record<string, readonly string[]> = {
  'body.rate': ['metric', 'windowMs', 'delta', 'slope', 'direction', 'timeToFloorMs', 'severity', 'ruleId'],
  'body.anomaly': ['metric', 'value', 'baseline', 'deviation', 'k', 'confidence', 'dates', 'severity', 'ruleId'],
  'file.burst': [
    'directory',
    'windowMs',
    'created',
    'modified',
    'deleted',
    'agentCreated',
    'agentModified',
    'agentDeleted',
    'externalDeletionExceeded',
  ],
};

export function eventDetail(signal: Signal): EventEntry['detail'] {
  const fields = detailFields[signal.kind];
  if (!fields) return undefined;
  return Object.fromEntries(
    fields.flatMap((key) => {
      const value = signal.data[key];
      return typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
        ? [[key, value]]
        : [];
    }),
  );
}
