import type { DisksFact } from './disks.js';
import type { Fact } from './index.js';

/** Agent "body vitals" facts (DESIGN §2.2b). */
export interface Body {
  cpu: Fact<{
    usage: number;
    perCore: number[];
    load1: number;
    load5: number;
    load15: number;
  }>;
  memory: Fact<{
    total: number;
    used: number;
    pressure: 'normal' | 'warn' | 'critical';
    swapUsed: number;
  }>;
  /** 磁盘：各挂载点独立读数，父级状态仅做聚合（见 DisksFact）。 */
  disks: DisksFact;
  /** `null` value on desktops without a battery. */
  battery: Fact<{
    percent: number;
    charging: boolean;
    minutesLeft?: number;
    powerState?: 'battery' | 'charging' | 'charged' | 'external';
    estimatePending?: boolean;
  } | null>;
  thermal: Fact<'nominal' | 'fair' | 'serious' | 'critical'>;
  network: Fact<{ online: boolean; rxBps: number; txBps: number }>;
  harnessProcess: Fact<{ rss: number; cpu: number; uptimeSec: number }>;
  tokens: Fact<{
    contextWindow?: number;
    contextUsed?: number;
    contextProjected?: number;
    sessionUsage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    balance?: { amount: number; currency: string; source: string };
  }>;
}
