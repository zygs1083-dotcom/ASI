import type { SleepPanelModel } from '../../shared/types.ts';
import type { WireSleepPanelModel } from './wire-types.ts';

export function toWireSleepPanelModel(model: SleepPanelModel): WireSleepPanelModel {
  return structuredClone(model);
}
