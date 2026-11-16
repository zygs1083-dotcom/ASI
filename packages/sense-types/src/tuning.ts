/** Values an attention/body tuning parameter may take. */
export type TuningValue = number | string | boolean;

/** A recorded change to a tuning parameter (audit trail; DESIGN §2.2c). */
export interface TuningChange {
  id: string;
  param: string;
  from: TuningValue;
  to: TuningValue;
  by: 'agent' | 'user' | 'auto';
  reason: string;
  at: number;
}
