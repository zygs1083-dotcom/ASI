import type { GrowthPanelModel } from '../../shared/types.ts';
import type { WireGrowthPanelModel } from './wire-types.ts';

export function toWireGrowthPanelModel(model: GrowthPanelModel): WireGrowthPanelModel {
  return structuredClone(model);
}
