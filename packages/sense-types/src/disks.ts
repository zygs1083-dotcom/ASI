import type { Fact, FactStatus } from './index.js';

/**
 * 单个磁盘挂载点的采样记录。
 *
 * status/observedAt/ttlMs 均为可选，保证旧版 payload
 * （仅 mount/total/free）仍然合法：
 * - status 缺省时该卷没有自声明状态，父事实的有效状态
 *   （effectiveStatus：status 字段叠加 TTL 过期判定）作为上限/兜底；
 * - observedAt/ttlMs 缺省时回落到父事实同名字段；
 * - 一旦 volume 自声明 status，它就是权威的，父状态不再封顶。
 */
export interface DiskVolume {
  mount: string;
  total: number;
  free: number;
  /** 卷级自声明新鲜度；缺省时沿用父事实的有效状态。 */
  status?: FactStatus;
  observedAt?: number;
  ttlMs?: number;
}

/**
 * 磁盘列表事实。value 为各挂载点的独立读数，
 * unavailableMounts 列出本轮连记录都拿不到的挂载点
 * （即使同名列在 value 里，也以 unavailableMounts 为准）。
 *
 * 父级聚合语义（生产方约定）：
 * - 任一卷为 fresh/ok → status 'ok'；
 * - 有值但全部 stale → 'stale'；无值 → 'unknown'；
 * - 'denied'/'unsupported' 由采集失败直接置位，不做聚合；
 * - observedAt 取 fresh 卷中最旧的采样时间；
 * - ttlMs = fresh 卷中最早绝对过期时刻 − 最旧 fresh observedAt，
 *   即父事实的保鲜窗口只覆盖仍然新鲜的那部分数据。
 */
export type DisksFact = Fact<DiskVolume[]> & {
  unavailableMounts?: string[];
};
