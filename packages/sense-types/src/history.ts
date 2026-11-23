/**
 * Shared 5-minute short-term trend ring types for body vitals.
 */

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export const THERMAL_ORDINAL: Record<ThermalState, number> = {
  nominal: 0,
  fair: 1,
  serious: 2,
  critical: 3,
};

export interface MetricPoint {
  at: number;
  value: number;
}

export type MetricKey =
  | 'cpu'
  | 'memory'
  | 'battery'
  | 'thermal'
  | 'networkRx'
  | 'networkTx'
  | 'processCpu'
  | 'processRss'
  | 'tokens'
  | `disk:${string}`
  | `diskFree:${string}`;

export interface BodyHistory {
  cpu: MetricPoint[];
  memory: MetricPoint[];
  /** Battery percentage (0..100); empty when no battery is present. */
  battery: MetricPoint[];
  /** Thermal ordinal: nominal 0 / fair 1 / serious 2 / critical 3. */
  thermal: MetricPoint[];
  networkRx: MetricPoint[];
  networkTx: MetricPoint[];
  processCpu: MetricPoint[];
  processRss: MetricPoint[];
  tokens: MetricPoint[];
  /** Used ratio (0..1) per mount, for sparklines. */
  disks: Record<string, MetricPoint[]>;
  /** Free bytes per mount, for exact drop-rate calculation. */
  diskFree?: Record<string, MetricPoint[]>;
}
