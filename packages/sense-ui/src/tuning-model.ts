import type { MetricKey } from './view-model';

export interface TuningParam {
  key: string;
  label: string;
  value: number | string;
  unit?: string;
  locked: boolean;
}

export interface TuningEntry {
  id: string;
  paramKey: string;
  previous: number | string;
  next: number | string;
  by: 'agent' | 'user' | 'auto';
  reason: string;
  at: number;
  reverted?: boolean;
  undoable?: boolean;
}

export interface TuningState {
  parameters: TuningParam[];
  log: TuningEntry[];
  disabled?: { reason: 'storage-failed' | 'restore-failed' };
  backupError?: { code: string; stage: 'backup' | 'save' };
  backupNotice?: { kind: 'corrupt' | 'unknown-version'; fileName: string };
  restoreKind?: 'corrupt' | 'unknown-version';
  suggestions?: {
    id: string;
    metric: MetricKey;
    unit: 'ratio' | 'bytes' | 'tokens' | 'bytes-per-second' | 'ordinal' | 'percent';
    slotLabel: string;
    from: number;
    to: number;
    samples: number;
    dates: number;
  }[];
}
