import { validateSnapshot } from './tuner-persist.ts';
import type { ParameterSpec } from './tuner-spec.ts';

const invalid = '\x00invalid';

function validApplied(entries: ReturnType<typeof validateSnapshot>, specs: Record<string, ParameterSpec>): boolean {
  if (!entries) return false;
  const changes = [
    ...entries.applied,
    ...entries.log.filter(
      (entry) => entry.status === 'applied' && (entry.operation === 'propose' || entry.operation === 'revert'),
    ),
  ];
  const legal = changes.every((entry) => {
    if (entry.kind === 'rebaseline')
      return (
        /^baseline:[\w-]+:[\w-]+:\d{1,3}$/.test(entry.param) &&
        typeof entry.from === 'number' &&
        typeof entry.to === 'number'
      );
    const spec = specs[entry.param];
    if (!spec) return false;
    return [entry.from, entry.to].every(
      (value) =>
        typeof value === typeof spec.value &&
        (!spec.choices || spec.choices.includes(value)) &&
        (typeof value !== 'number' ||
          ((spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max))),
    );
  });
  if (!legal) return false;
  const latest = new Map<string, (typeof changes)[number]>();
  for (const entry of changes) {
    if (entry.kind === 'rebaseline') continue;
    const previous = latest.get(entry.param);
    const seq = (id: string) => Number(id.slice(entries.idPrefix.length + 1));
    if (!previous || seq(entry.id) > seq(previous.id)) latest.set(entry.param, entry);
  }
  return entries.values.every(([param, value]) => value === (latest.get(param)?.to ?? specs[param]?.value));
}

export function markTuningSnapshot(text: string): string {
  const monitor = JSON.parse(text);
  if (monitor.disabled === 'restore-failed') return JSON.stringify({ version: 2, disabled: 'restore-failed' });
  monitor.version = 2;
  return JSON.stringify(monitor);
}

export function migrateTuningSnapshot(
  text: string | undefined,
  previous: Record<string, ParameterSpec>,
  added: Record<string, ParameterSpec>,
  wallClock: () => number,
): string | undefined {
  if (text === undefined) return undefined;
  try {
    const monitor = JSON.parse(text);
    if (
      (monitor?.version === 1 || monitor?.version === 2) &&
      monitor.disabled === 'restore-failed' &&
      Object.keys(monitor).length === 2
    )
      return JSON.stringify({ version: 1, disabled: 'restore-failed' });
    if ((monitor?.version !== 1 && monitor?.version !== 2) || typeof monitor.tuner !== 'string') return invalid;
    const tuner = JSON.parse(monitor.tuner);
    const legacy = {
      ...previous,
      'rate.context.maxEtaMs': { ...previous['rate.context.maxEtaMs'], min: 1, tighten: undefined },
    };
    const specs = monitor.version === 1 ? legacy : { ...previous, ...added };
    const validated = validateSnapshot(monitor.tuner, specs);
    if (!validApplied(validated, { ...specs, 'rate.context.maxEtaMs': legacy['rate.context.maxEtaMs'] }))
      return invalid;
    if (monitor.version === 1) {
      const eta = tuner.values.find(([key]: [string, unknown]) => key === 'rate.context.maxEtaMs');
      const floor = previous['rate.context.maxEtaMs'].min as number;
      if (eta[1] < floor) {
        if (!Number.isSafeInteger(tuner.nextId + 1)) return invalid;
        const change = {
          id: `${tuner.idPrefix}-${tuner.nextId++}`,
          param: 'rate.context.maxEtaMs',
          from: eta[1],
          to: floor,
          by: 'auto',
          reason: '新版底线',
          at: wallClock(),
          operation: 'propose',
          status: 'applied',
        };
        eta[1] = floor;
        tuner.log.push(change);
        tuner.applied.push(change);
      }
      tuner.values.push(...Object.entries(added).map(([key, spec]) => [key, spec.value]));
      monitor.tuner = JSON.stringify(tuner);
    }
    monitor.version = 1;
    return JSON.stringify(monitor);
  } catch {
    return invalid;
  }
}
