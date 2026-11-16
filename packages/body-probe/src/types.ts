// 共享契约在 @asi/sense-types（docs/DESIGN.md §2.2 / §2.2b）；本包只保留
// memory.cached 这一处本机扩投影和 TokenSource 接口。

import type { Body as SharedBody, Fact } from '@asi/sense-types';

export type {
  DiskVolume,
  DisksFact,
  Fact,
  FactStatus,
  SourceRef,
} from '@asi/sense-types';

export type Body = Omit<SharedBody, 'memory'> & {
  // vm_stat 额外给出 cached files 字节数；插件契约之外的本机扩展字段
  memory: Fact<NonNullable<SharedBody['memory']['value']> & { cached?: number }>;
};

export type CpuValue = NonNullable<Body['cpu']['value']>;
export type MemoryValue = NonNullable<Body['memory']['value']>;
export type DisksValue = NonNullable<Body['disks']['value']>;
export type BatteryValue = NonNullable<Body['battery']['value']>;
export type ThermalValue = NonNullable<Body['thermal']['value']>;
export type NetworkValue = NonNullable<Body['network']['value']>;
export type ProcessValue = NonNullable<Body['harnessProcess']['value']>;
export type TokensValue = NonNullable<Body['tokens']['value']>;
export type BalanceValue = NonNullable<TokensValue['balance']>;

export interface TokenSource {
  read(): Promise<Fact<Body['tokens']['value']>>;
}
