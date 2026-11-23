/** 指标卡片 memo 基础设施：行级依赖收集 + 重渲判定。 */

import { memo, type ReactNode } from 'react';
import { effectiveDisks } from '../disk-health';
import { type BodyRowKey, diskFact, effectiveStatus, rowFact } from '../health';
import type { Fact, NeedsPanelModel, NeedsPanelProps } from '../view-model';

export interface TileCtx {
  model: NeedsPanelProps['model'];
  onOpenPermissionSettings: () => void;
}

type Rows = ReturnType<typeof import('../health').evaluateBody>['rows'];

export interface MetricTileProps {
  model: NeedsPanelModel;
  rows: Rows;
  ctx: TileCtx;
}

/** 行事实集合：磁盘行含每卷派生事实（卷级状态也参与变化检测）。 */
function tileFacts(key: BodyRowKey, m: NeedsPanelModel, now: number): Fact<unknown>[] {
  if (key !== 'disks') return [rowFact(key, m.state.self.body)];
  const df = m.state.self.body.disks;
  return [effectiveDisks(df, now), ...(df.value ?? []).map((d) => diskFact(df, d, now))];
}

/**
 * 指标卡片 memo：纯时钟推进不算依赖。重渲条件：
 * 行严重度/可见性/完整性(partial)、回调、自身 deps 引用、
 * 以及每个行事实在前后两帧的有效状态翻转。
 * 年龄由时钟订阅独立处理，图窗口随数据更新。
 */
export function memoTile(
  key: BodyRowKey,
  deps: (m: NeedsPanelModel) => readonly unknown[],
  C: (p: MetricTileProps) => ReactNode,
) {
  return memo(C, (a, b) => {
    if (
      a.rows[key].severity !== b.rows[key].severity ||
      a.rows[key].hidden !== b.rows[key].hidden ||
      a.rows[key].partial !== b.rows[key].partial ||
      a.ctx.onOpenPermissionSettings !== b.ctx.onOpenPermissionSettings
    ) {
      return false;
    }
    const na = a.model.now;
    const nb = b.model.now;
    const fa = tileFacts(key, a.model, na);
    const fb = tileFacts(key, b.model, nb);
    if (fa.length !== fb.length) return false;
    for (let i = 0; i < fa.length; i++) {
      if (effectiveStatus(fa[i]!, na) !== effectiveStatus(fb[i]!, nb)) return false;
    }
    const da = deps(a.model);
    const db = deps(b.model);
    return da.length === db.length && da.every((d, i) => d === db[i]);
  });
}
