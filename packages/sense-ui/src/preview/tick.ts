/** 预览实时模式用的确定性 tick（导出供单测验证，不进入组件逻辑）。 */

import {
  THERMAL_ORDINAL,
  type Body,
  type BodyHistory,
  type Fact,
  type MetricPoint,
  type SensePanelModel,
} from '../view-model'

/** 只有原始 status 为 ok 的事实才刷新 observedAt；stale/denied 等状态原样保留。 */
const refresh = <T>(f: Fact<T>, now: number): Fact<T> =>
  f.status === 'ok' ? { ...f, observedAt: now } : f

/** 仅在值非 null 时追加历史点；始终裁剪到最近 5 分钟。 */
const push = (pts: MetricPoint[], now: number, v: number | null | undefined): MetricPoint[] => {
  const pruned = pts.filter((p) => p.at > now - 300_000)
  return v == null ? pruned : [...pruned, { at: now, value: v }]
}

export function tick(m: SensePanelModel): SensePanelModel {
  const now = m.now + 1_000
  if (m.paused) return { ...m, now }
  const t = now / 1_000
  const body: Body = { ...m.state.self.body }

  // cpu / network / tokens 做正弦动态，其余 ok 事实只刷新新鲜度（静止也是有效观测）
  body.cpu = refresh(body.cpu, now)
  if (body.cpu.status === 'ok' && body.cpu.value) {
    body.cpu = {
      ...body.cpu,
      value: {
        ...body.cpu.value,
        usage: Math.max(0.02, 0.35 + 0.2 * Math.sin(t / 17)),
        perCore: body.cpu.value.perCore.map((_, i) =>
          Math.max(0.02, 0.3 + 0.25 * Math.sin(t / 9 + i)),
        ),
      },
    }
  }
  body.memory = refresh(body.memory, now)
  body.disks = refresh(body.disks, now)
  body.battery = refresh(body.battery, now)
  body.thermal = refresh(body.thermal, now)
  body.network = refresh(body.network, now)
  if (body.network.status === 'ok' && body.network.value) {
    body.network = {
      ...body.network,
      value: {
        ...body.network.value,
        rxBps: Math.max(0, 400_000 + 300_000 * Math.sin(t / 11)),
        txBps: Math.max(0, 90_000 + 60_000 * Math.sin(t / 7)),
      },
    }
  }
  body.harnessProcess = refresh(body.harnessProcess, now)
  body.tokens = refresh(body.tokens, now)
  if (body.tokens.status === 'ok' && body.tokens.value?.contextUsed != null) {
    const window = body.tokens.value.contextWindow
    const used =
      window != null && window > 0
        ? Math.min(window, body.tokens.value.contextUsed + 120)
        : body.tokens.value.contextUsed + 120
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
    }
  }

  const ok = <T,>(f: Fact<T>) => (f.status === 'ok' ? f.value : null)
  const cv = ok(body.cpu)
  const mv = ok(body.memory)
  const nv = ok(body.network)
  const pv = ok(body.harnessProcess)
  const tv = ok(body.tokens)
  const history: BodyHistory = {
    ...m.history,
    cpu: push(m.history.cpu, now, cv?.usage),
    memory: push(m.history.memory, now, mv && mv.total > 0 ? mv.used / mv.total : null),
    battery: push(m.history.battery, now, ok(body.battery)?.percent),
    thermal: push(
      m.history.thermal,
      now,
      ok(body.thermal) ? THERMAL_ORDINAL[body.thermal.value!] : null,
    ),
    networkRx: push(m.history.networkRx, now, nv?.rxBps),
    networkTx: push(m.history.networkTx, now, nv?.txBps),
    processCpu: push(m.history.processCpu, now, pv?.cpu),
    processRss: push(m.history.processRss, now, pv?.rss),
    tokens: push(m.history.tokens, now, tv?.contextUsed),
    disks: Object.fromEntries(
      Object.entries(m.history.disks).map(([mount, pts]) => {
        const disk =
          body.disks.status === 'ok'
            ? body.disks.value?.find((d) => d.mount === mount)
            : undefined
        return [
          mount,
          push(pts, now, disk && disk.total > 0 ? 1 - disk.free / disk.total : null),
        ]
      }),
    ),
  }
  // 身体以外的 self/env 事实同样只刷新 ok 的新鲜度，保留夹具的 stale/denied。
  const self = {
    ...m.state.self,
    body,
    activity: refresh(m.state.self.activity, now),
    pending: refresh(m.state.self.pending, now),
    tools: refresh(m.state.self.tools, now),
    permissions: refresh(m.state.self.permissions, now),
  }
  const env = {
    ...m.state.env,
    where: {
      model: refresh(m.state.env.where.model, now),
      harness: refresh(m.state.env.where.harness, now),
      observed: refresh(m.state.env.where.observed, now),
      toolExec: refresh(m.state.env.where.toolExec, now),
    },
    frontApp: refresh(m.state.env.frontApp, now),
    focusedWindow: refresh(m.state.env.focusedWindow, now),
    activeJobs: refresh(m.state.env.activeJobs, now),
    watchedPaths: refresh(m.state.env.watchedPaths, now),
  }
  return {
    ...m,
    now,
    history,
    state: { ...m.state, self, env },
  }
}
