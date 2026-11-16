import { validateSnapshot } from './tuner-persist.ts';
import type { ParameterSpec } from './tuner-spec.ts';

export function migrateTuningSnapshot(
  text: string | undefined,
  previous: Record<string, ParameterSpec>,
  added: Record<string, ParameterSpec>,
): string | undefined {
  if (text === undefined) return undefined;
  try {
    const monitor = JSON.parse(text);
    if (monitor?.version !== 1 || typeof monitor.tuner !== 'string') return text;
    const tuner = JSON.parse(monitor.tuner);
    if (!Array.isArray(tuner.values) || tuner.values.length !== Object.keys(previous).length) return text;
    if (!validateSnapshot(monitor.tuner, previous)) return text;
    tuner.values.push(...Object.entries(added).map(([key, spec]) => [key, spec.value]));
    monitor.tuner = JSON.stringify(tuner);
    return JSON.stringify(monitor);
  } catch {
    return text;
  }
}
