/** 预览实时模式用的确定性 tick（导出供单测验证，不进入组件逻辑）。 */

import { effectiveDisks } from '@asi/sense-types';
import { diskUsable } from '../disk-health';
import {
  type Body,
  type BodyHistory,
  type DisksFact,
  type Fact,
  type MetricPoint,
  type SensePanelModel,
  THERMAL_ORDINAL,
} from '../view-model';

const HISTORY_MS = 300_000;

/**
 * 续期判定：原始 status 为 ok 且距上次观察已满 2/3·TTL（TTL 有限为正）。
 * 非 ok 事实永不续期；未到期事实返回原引用，保证未采样数据零改动。
 */
const due = (observedAt: number, ttlMs: number, now: number): boolean =>
  Number.isFinite(ttlMs) && ttlMs > 0 && (now - observedAt) * 3 >= ttlMs * 2;

const renew = <T>(f: Fact<T>, now: number): Fact<T> =>
  f.status === 'ok' && due(f.observedAt, f.ttlMs, now) ? { ...f, observedAt: now } : f;

/**
 * 磁盘事实续期：各卷按有效状态和期限独立判断，仅新鲜卷到 2/3·TTL 时
 * 刷新 observedAt；续期时物化未刷新的卷，避免父级变化复活旧卷。
 */
function renewDisks(f: DisksFact, now: number): DisksFact {
  const volumes = effectiveDisks(f, now).value ?? [];
  if (!volumes.some((v) => v.status === 'ok' && due(v.observedAt, v.ttlMs, now))) return f;
  const value = volumes.map((v, i) => {
    const original = f.value![i]!;
    if (v.status === 'ok' && due(v.observedAt, v.ttlMs, now)) {
      return { ...v, observedAt: now, ttlMs: original.ttlMs ?? f.ttlMs };
    }
    return original.status === v.status && original.observedAt === v.observedAt && original.ttlMs === v.ttlMs
      ? original
      : v;
  });
  const { status, observedAt, ttlMs } = effectiveDisks({ ...f, value }, now);
  return { ...f, value, status, observedAt, ttlMs };
}

/** 仅在值非 null 时追加历史点；始终裁剪到最近 5 分钟。 */
const push = (pts: MetricPoint[], now: number, v: number | null | undefined): MetricPoint[] => {
  const pruned = pts.filter((p) => p.at > now - HISTORY_MS);
  return v == null ? pruned : [...pruned, { at: now, value: v }];
};

export function tick(m: SensePanelModel): SensePanelModel {
  const now = m.now + 1_000;
  if (m.paused) return { ...m, now };
  const t = now / 1_000;
  const b0 = m.state.self.body;
  const body: Body = { ...b0 };

  // cpu / network / tokens 做正弦动态并随采样落新 observedAt；
  // 其余 ok 事实按 2/3·TTL 周期续期（静止也是有效观测），非 ok 原样保留。
  if (body.cpu.status === 'ok') {
    body.cpu = { ...body.cpu, observedAt: now };
    if (body.cpu.value) {
      body.cpu = {
        ...body.cpu,
        value: {
          ...body.cpu.value,
          usage: Math.max(0.02, 0.35 + 0.2 * Math.sin(t / 17)),
          perCore: body.cpu.value.perCore.map((_, i) => Math.max(0.02, 0.3 + 0.25 * Math.sin(t / 9 + i))),
        },
      };
    }
  }
  body.memory = renew(body.memory, now);
  body.disks = renewDisks(body.disks, now);
  body.battery = renew(body.battery, now);
  body.thermal = renew(body.thermal, now);
  if (body.network.status === 'ok') {
    body.network = { ...body.network, observedAt: now };
    if (body.network.value) {
      body.network = {
        ...body.network,
        value: {
          ...body.network.value,
          rxBps: Math.max(0, 400_000 + 300_000 * Math.sin(t / 11)),
          txBps: Math.max(0, 90_000 + 60_000 * Math.sin(t / 7)),
        },
      };
    }
  }
  body.harnessProcess = renew(body.harnessProcess, now);
  if (body.tokens.status === 'ok') {
    body.tokens = { ...body.tokens, observedAt: now };
    if (body.tokens.value?.contextUsed != null) {
      const window = body.tokens.value.contextWindow;
      const used =
        window != null && window > 0
          ? Math.min(window, body.tokens.value.contextUsed + 120)
          : body.tokens.value.contextUsed + 120;
      body.tokens = {
        ...body.tokens,
        value: {
          ...body.tokens.value,
          contextUsed: used,
          contextProjected:
            body.tokens.value.contextProjected != null
              ? window != null && window > 0
                ? Math.min(window, used + 6_600)
                : used + 6_600
              : undefined,
        },
      };
    }
  }

  const ok = <T>(f: Fact<T>) => (f.status === 'ok' ? f.value : null);
  const cv = ok(body.cpu);
  const mv = ok(body.memory);
  const nv = ok(body.network);
  const pv = ok(body.harnessProcess);
  const tv = ok(body.tokens);
  const previousDisks = effectiveDisks(b0.disks, now).value ?? [];
  // 历史只随「本次采样有变化的事实」推进：未更新的事实保留原数组引用；
  // 变化时先按 5 分钟窗裁剪，值缺失/不可用不补点。
  const history: BodyHistory = {
    ...m.history,
    cpu: body.cpu !== b0.cpu ? push(m.history.cpu, now, cv?.usage) : m.history.cpu,
    memory:
      body.memory !== b0.memory
        ? push(m.history.memory, now, mv && mv.total > 0 ? mv.used / mv.total : null)
        : m.history.memory,
    battery: body.battery !== b0.battery ? push(m.history.battery, now, ok(body.battery)?.percent) : m.history.battery,
    thermal:
      body.thermal !== b0.thermal
        ? push(m.history.thermal, now, ok(body.thermal) ? THERMAL_ORDINAL[body.thermal.value!] : null)
        : m.history.thermal,
    networkRx: body.network !== b0.network ? push(m.history.networkRx, now, nv?.rxBps) : m.history.networkRx,
    networkTx: body.network !== b0.network ? push(m.history.networkTx, now, nv?.txBps) : m.history.networkTx,
    processCpu:
      body.harnessProcess !== b0.harnessProcess ? push(m.history.processCpu, now, pv?.cpu) : m.history.processCpu,
    processRss:
      body.harnessProcess !== b0.harnessProcess ? push(m.history.processRss, now, pv?.rss) : m.history.processRss,
    tokens: body.tokens !== b0.tokens ? push(m.history.tokens, now, tv?.contextUsed) : m.history.tokens,
    disks:
      body.disks !== b0.disks
        ? Object.fromEntries(
            Object.entries(m.history.disks).map(([mount, pts]) => {
              const d = body.disks.value?.find((v) => v.mount === mount);
              const previous = previousDisks.find((v) => v.mount === mount);
              if (!d || d.observedAt === previous?.observedAt) return [mount, pts];
              const v = diskUsable(body.disks, d, now) && d.total > 0 ? 1 - d.free / d.total : null;
              return [mount, push(pts, now, v)];
            }),
          )
        : m.history.disks,
  };
  // 身体以外的 self/env 事实同样按周期续期；全部未变时保留原对象引用。
  const s0 = m.state.self;
  const activity = renew(s0.activity, now);
  const pending = renew(s0.pending, now);
  const tools = renew(s0.tools, now);
  const permissions = renew(s0.permissions, now);
  const self =
    activity === s0.activity &&
    pending === s0.pending &&
    tools === s0.tools &&
    permissions === s0.permissions &&
    body === s0.body
      ? s0
      : { ...s0, body, activity, pending, tools, permissions };
  const w0 = m.state.env.where;
  const where = {
    model: renew(w0.model, now),
    harness: renew(w0.harness, now),
    observed: renew(w0.observed, now),
    toolExec: renew(w0.toolExec, now),
  };
  const whereSame =
    where.model === w0.model &&
    where.harness === w0.harness &&
    where.observed === w0.observed &&
    where.toolExec === w0.toolExec;
  const e0 = m.state.env;
  const frontApp = renew(e0.frontApp, now);
  const focusedWindow = renew(e0.focusedWindow, now);
  const activeJobs = renew(e0.activeJobs, now);
  const watchedPaths = renew(e0.watchedPaths, now);
  const env =
    whereSame &&
    frontApp === e0.frontApp &&
    focusedWindow === e0.focusedWindow &&
    activeJobs === e0.activeJobs &&
    watchedPaths === e0.watchedPaths
      ? e0
      : {
          ...e0,
          where: whereSame ? w0 : where,
          frontApp,
          focusedWindow,
          activeJobs,
          watchedPaths,
        };
  return {
    ...m,
    now,
    history,
    state: { ...m.state, self, env },
  };
}
