import type { Signal } from '@asi/sense-types';
import type { EventEntry } from './attention.ts';

const detailFields: Record<string, readonly string[]> = {
  'body.rate': [
    'metric',
    'windowMs',
    'delta',
    'slope',
    'direction',
    'timeToFloorMs',
    'severity',
    'ruleId',
    'evidenceAt',
    'evidenceMono',
  ],
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
  'file.activity': ['directory', 'windowMs', 'created', 'modified', 'deleted', 'degraded'],
};

export function eventDetail(signal: Signal): EventEntry['detail'] {
  const fields = detailFields[signal.kind];
  if (!fields) return undefined;
  const entries: [string, string | number | boolean][] = fields.flatMap((key) => {
    const value = signal.data[key];
    return typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
      ? [[key, value]]
      : [];
  });
  if (signal.kind === 'file.activity' && Array.isArray(signal.data.files)) {
    const files = signal.data.files
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 5);
    if (files.length > 0) entries.push(['files', files.join(', ')]);
  }
  return Object.fromEntries(entries);
}
