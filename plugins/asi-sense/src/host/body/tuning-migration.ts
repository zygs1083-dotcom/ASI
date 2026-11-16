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
  monitor.version = 2;
  return JSON.stringify(monitor);
}

export function migrateTuningSnapshot(
  text: string | undefined,
  previous: Record<string, ParameterSpec>,
  added: Record<string, ParameterSpec>,
): string | undefined {
  if (text === undefined) return undefined;
  try {
    const monitor = JSON.parse(text);
    if ((monitor?.version !== 1 && monitor?.version !== 2) || typeof monitor.tuner !== 'string') return invalid;
    const tuner = JSON.parse(monitor.tuner);
    const specs = monitor.version === 1 ? previous : { ...previous, ...added };
    const validated = validateSnapshot(monitor.tuner, specs);
    if (!validApplied(validated, specs)) return invalid;
    if (monitor.version === 1) {
      tuner.values.push(...Object.entries(added).map(([key, spec]) => [key, spec.value]));
      monitor.tuner = JSON.stringify(tuner);
    }
    monitor.version = 1;
    return JSON.stringify(monitor);
  } catch {
    return invalid;
  }
}
