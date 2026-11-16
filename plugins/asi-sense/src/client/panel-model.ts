import type { MetricKey, SensePanelModel } from '@asi/sense-ui/model';
import type { WirePanelModel } from '../host/dsh/wire-types.ts';

function isMetricKey(value: string): value is MetricKey {
  return (
    ['cpu', 'memory', 'battery', 'thermal', 'networkRx', 'networkTx', 'processCpu', 'processRss', 'tokens'].includes(
      value,
    ) || value.startsWith('disk:')
  );
}

export function panelModel(frame: WirePanelModel): SensePanelModel {
  const { tuning, ...rest } = frame;
  if (tuning === undefined) return rest;
  const { suggestions, ...other } = tuning;
  const checked = suggestions?.map((suggestion) => {
    if (!isMetricKey(suggestion.metric)) throw new TypeError('unrecognized tuning metric in frame');
    return { ...suggestion, metric: suggestion.metric };
  });
  return { ...rest, tuning: { ...other, ...(checked === undefined ? {} : { suggestions: checked }) } };
}
