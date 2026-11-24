/**
 * Pure deterministic evaluator for the 5 infant-stage survival needs with a
 * continuous homeostatic tension model (0..100 satisfaction & urgency + Schmitt
 * trigger hysteresis: <25 critical, <60 uncomfortable, drive clears only >=70).
 */

import {
  effectiveDisks,
  type MetricPoint,
  type ModelConnectivity,
  NEED_KEYS,
  type NeedEvaluation,
  type NeedKey,
  type NeedZone,
  type SenseSnapshot,
} from '@asi/sense-types';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export const NEED_LABELS: Record<NeedKey, string> = {
  energy: '能量',
  space: '空间',
  memory: '内存与进程',
  mind: '心智容量',
  thermals: '体温负荷',
};

export interface PreviousNeedState {
  zone: NeedZone;
  driveActive: boolean;
  satisfaction?: number;
  mount?: string;
  sessionId?: string;
  batteryDriven?: boolean;
}

export interface EvaluateNeedsInput {
  snapshot: SenseSnapshot;
  modelConnectivity: ModelConnectivity;
  stuckJobCount: number;
  previous?: Partial<Record<NeedKey, PreviousNeedState>>;
}

export interface EvaluatedNeedsResult {
  now: number;
  overallSatisfaction: number;
  overallUrgency: number;
  overallZone: NeedZone;
  activeDrives: NeedKey[];
  needs: Record<NeedKey, NeedEvaluation>;
}

function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function holdDriveSat(prev: PreviousNeedState): number {
  const fallback = prev.zone === 'critical' ? 20 : 45;
  const raw = prev.satisfaction !== undefined && Number.isFinite(prev.satisfaction) ? prev.satisfaction : fallback;
  return Math.min(69, clamp100(raw));
}

export function applyHysteresis(
  rawSatisfaction: number,
  prev?: PreviousNeedState,
): { satisfaction: number; urgency: number; zone: NeedZone; driveActive: boolean } {
  const satisfaction = clamp100(rawSatisfaction);
  const urgency = 100 - satisfaction;
  if (satisfaction < 25) {
    return { satisfaction, urgency, zone: 'critical', driveActive: true };
  }
  if (satisfaction < 60) {
    return { satisfaction, urgency, zone: 'uncomfortable', driveActive: true };
  }
  if (satisfaction < 70 && prev?.driveActive === true) {
    return { satisfaction, urgency, zone: 'uncomfortable', driveActive: true };
  }
  return { satisfaction, urgency, zone: 'comfortable', driveActive: false };
}

function formatGiB(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GB`;
  return `${Math.round(bytes / MIB)} MB`;
}

/**
 * Returns free-space drop rate in bytes/minute (negative when dropping) over
 * the 5-minute trend ring, or 0 when insufficient points exist (<30s span).
 */
export function computeDiskDropPerMin(points: readonly MetricPoint[] | undefined, now: number): number {
  if (!points || points.length < 2) return 0;
  const recent = points.filter(
    (p) => Number.isFinite(p.at) && Number.isFinite(p.value) && p.at >= now - 300_000 && p.at <= now,
  );
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last) return 0;
  const dtMs = last.at - first.at;
  if (dtMs < 30_000) return 0;
  const perMin = (last.value - first.value) / (dtMs / 60_000);
  return Number.isFinite(perMin) ? perMin : 0;
}

function evalEnergy(
  snapshot: SenseSnapshot,
  connectivity: ModelConnectivity,
  prev?: PreviousNeedState,
): NeedEvaluation {
  const { battery, network } = snapshot.state.self.body;
  const modelWhere = snapshot.state.env.where.model;
  const isRemoteModel = modelWhere.status === 'ok' && modelWhere.value?.local === false;
  const netOffline = network.status === 'ok' && network.value?.online === false;

  const effectiveConn: ModelConnectivity =
    connectivity === 'offline' || (netOffline && isRemoteModel)
      ? 'offline'
      : connectivity === 'degraded' || netOffline
        ? 'degraded'
        : 'online';

  let batSat = 100;
  let batSummary = '外接电源稳定';
  const evidence: Record<string, string | number | boolean | null> = {
    modelConnectivity: effectiveConn,
  };

  if (battery.status === 'ok' && battery.value === null) {
    batSat = 100;
    batSummary = '外接交流供电';
    evidence.powerSource = 'ac-mains';
  } else if (battery.status === 'ok' && battery.value) {
    const b = battery.value;
    const pct = Math.max(0, Math.min(100, b.percent));
    const plugged =
      b.charging === true || b.powerState === 'charging' || b.powerState === 'charged' || b.powerState === 'external';
    evidence.batteryPercent = pct;
    evidence.pluggedIn = plugged;
    if (b.minutesLeft !== undefined && Number.isFinite(b.minutesLeft)) {
      evidence.minutesLeft = Math.round(b.minutesLeft);
    }

    if (plugged) {
      batSat = Math.max(75, pct);
      batSummary = `已接电源（电量 ${Math.round(pct)}%）`;
    } else if (pct >= 40) {
      batSat = 70 + Math.round(((pct - 40) / 60) * 30);
      batSummary = `电池供电（${Math.round(pct)}%）`;
    } else if (pct >= 15) {
      batSat = 25 + Math.round(((pct - 15) / 25) * 34);
      batSummary = `电量偏低（${Math.round(pct)}%，未接电源）`;
    } else {
      batSat = Math.max(0, Math.round((pct / 15) * 24));
      batSummary = `电量危急（仅剩 ${Math.round(pct)}%，请接通电源）`;
    }
    if (
      !plugged &&
      b.minutesLeft !== undefined &&
      Number.isFinite(b.minutesLeft) &&
      b.minutesLeft > 0 &&
      b.minutesLeft <= 15
    ) {
      batSat = Math.min(batSat, 15);
      batSummary = `续航不足 ${Math.ceil(b.minutesLeft)} 分钟，急需接通电源`;
    }
  } else if (
    prev?.driveActive &&
    prev.batteryDriven !== false &&
    battery.status !== 'unsupported' &&
    battery.status !== 'denied'
  ) {
    batSat = holdDriveSat(prev);
    evidence.batteryPercent = null;
    batSummary = '电源读数暂不可用，保持上次状态';
  } else {
    evidence.batteryPercent = null;
    batSummary = '电源状态待读取';
  }
  evidence.batteryDriven = batSat < 70;

  const connSat = effectiveConn === 'offline' ? 15 : effectiveConn === 'degraded' ? 45 : 100;
  const raw = Math.min(batSat, connSat);
  const h = applyHysteresis(raw, prev);

  const connNote =
    effectiveConn === 'offline'
      ? '模型网关失联'
      : effectiveConn === 'degraded'
        ? '网络或模型连接不稳'
        : '模型网关连通正常';

  return {
    key: 'energy',
    label: NEED_LABELS.energy,
    ...h,
    summary: `${batSummary} · ${connNote}`,
    evidence,
    updatedAt: snapshot.now,
  };
}

function evalSpace(snapshot: SenseSnapshot, prev?: PreviousNeedState): NeedEvaluation {
  const disks = effectiveDisks(snapshot.state.self.body.disks, Number.NEGATIVE_INFINITY);
  const freshVolumes = (disks.value ?? []).filter(
    (v) => v.status === 'ok' && Number.isFinite(v.total) && v.total > 0 && Number.isFinite(v.free) && v.free >= 0,
  );
  const partialCount = disks.indeterminateMounts.length;

  const firstVol = freshVolumes[0];
  if (!firstVol) {
    const raw =
      prev?.driveActive && disks.status !== 'unsupported' && disks.status !== 'denied' ? holdDriveSat(prev) : 100;
    const h = applyHysteresis(raw, prev);
    return {
      key: 'space',
      label: NEED_LABELS.space,
      ...h,
      summary: partialCount > 0 || prev?.driveActive ? '磁盘读数已过期或暂不可用，保持上次状态' : '磁盘空间待采集',
      evidence: {
        ...(prev?.mount ? { mount: prev.mount } : {}),
        freshVolumes: 0,
        indeterminateVolumes: partialCount,
      },
      updatedAt: snapshot.now,
    };
  }

  let worstSat = 101;
  let worstMount = firstVol.mount;
  let worstFree = firstVol.free;
  let worstRatio = firstVol.free / firstVol.total;
  let worstDropPerMin = 0;

  for (const vol of freshVolumes) {
    const ratio = Math.max(0, Math.min(1, vol.free / vol.total));
    let sat: number;
    if (vol.free < 2 * GIB || ratio < 0.03) {
      sat = Math.round(Math.min(vol.free / (2 * GIB), ratio / 0.03) * 20);
    } else if (vol.free < 5 * GIB || ratio <= 0.05) {
      sat = 18 + Math.round(Math.min((vol.free - 2 * GIB) / (3 * GIB), 1) * 6);
    } else if (vol.free < 15 * GIB || ratio <= 0.1) {
      const ratioProgress = Math.max(0, Math.min(1, (ratio - 0.05) / 0.05));
      const byteProgress = Math.max(0, Math.min(1, (vol.free - 5 * GIB) / (10 * GIB)));
      sat = 30 + Math.round(Math.min(ratioProgress, byteProgress) * 25);
    } else {
      sat = 70 + Math.round(Math.min(1, (ratio - 0.1) / 0.4) * 30);
    }

    const dropPerMin = computeDiskDropPerMin(snapshot.history.diskFree?.[vol.mount], snapshot.now);
    if (dropPerMin <= -500 * MIB) {
      const minToFloor = Math.max(0, vol.free - 2 * GIB) / Math.abs(dropPerMin);
      if (minToFloor <= 15) sat = Math.min(sat, 20);
      else if (minToFloor <= 45) sat = Math.min(sat, 45);
    } else if (dropPerMin <= -250 * MIB) {
      const minToFloor = Math.max(0, vol.free - 5 * GIB) / Math.abs(dropPerMin);
      if (minToFloor <= 45) sat = Math.min(sat, 48);
    }

    if (sat < worstSat) {
      worstSat = sat;
      worstMount = vol.mount;
      worstFree = vol.free;
      worstRatio = ratio;
      worstDropPerMin = dropPerMin;
    }
  }

  const prevMountIndeterminate =
    prev?.driveActive === true &&
    partialCount > 0 &&
    (prev.mount === undefined || disks.indeterminateMounts.includes(prev.mount));
  if (prevMountIndeterminate && prev) {
    const held = holdDriveSat(prev);
    if (held < worstSat) {
      const h = applyHysteresis(held, prev);
      const targetMount = prev.mount ?? disks.indeterminateMounts[0] ?? worstMount;
      return {
        key: 'space',
        label: NEED_LABELS.space,
        ...h,
        summary: `卷 ${targetMount} 读数已过期或暂不可用，保持上次状态`,
        evidence: {
          mount: targetMount,
          freshVolumes: freshVolumes.length,
          indeterminateVolumes: partialCount,
        },
        updatedAt: snapshot.now,
      };
    }
  }

  const h = applyHysteresis(worstSat, prev);
  const dropNote = worstDropPerMin <= -100 * MIB ? `，每分钟下降约 ${formatGiB(Math.abs(worstDropPerMin))}` : '';
  const partialNote = partialCount > 0 ? `（另有 ${partialCount} 个卷待刷新）` : '';

  return {
    key: 'space',
    label: NEED_LABELS.space,
    ...h,
    summary: `卷 ${worstMount} 剩余 ${formatGiB(worstFree)}（${Math.round(worstRatio * 100)}%）${dropNote}${partialNote}`,
    evidence: {
      mount: worstMount,
      freeBytes: Math.round(worstFree),
      freeRatio: Number(worstRatio.toFixed(4)),
      dropBytesPerMin: Math.round(worstDropPerMin),
      indeterminateVolumes: partialCount,
    },
    updatedAt: snapshot.now,
  };
}

function evalMemory(snapshot: SenseSnapshot, stuckJobCount: number, prev?: PreviousNeedState): NeedEvaluation {
  const { memory, harnessProcess } = snapshot.state.self.body;
  let memSat = 100;
  let memDesc = '系统内存充裕';
  const evidence: Record<string, string | number | boolean | null> = {
    stuckJobs: stuckJobCount,
  };

  if (memory.status === 'ok' && memory.value && memory.value.total > 0) {
    const { used, total, pressure } = memory.value;
    const ratio = Math.max(0, Math.min(1, used / total));
    evidence.pressure = pressure;
    evidence.usedRatio = Number(ratio.toFixed(4));
    if (pressure === 'critical' || ratio >= 0.95) {
      memSat = 15;
      memDesc = `系统内存危急（已用 ${Math.round(ratio * 100)}%）`;
    } else if (pressure === 'warn' || ratio >= 0.85) {
      memSat = 42;
      memDesc = `系统内存偏紧（已用 ${Math.round(ratio * 100)}%）`;
    } else {
      memSat = Math.max(70, Math.round(100 - Math.max(0, ratio - 0.5) * 60));
      memDesc = `系统内存正常（已用 ${Math.round(ratio * 100)}%）`;
    }
  } else if (prev?.driveActive && memory.status !== 'unsupported' && memory.status !== 'denied') {
    memSat = holdDriveSat(prev);
    memDesc = '系统内存读数暂不可用，保持上次状态';
  }

  let procSat = 100;
  let procDesc = '';
  if (harnessProcess.status === 'ok' && harnessProcess.value) {
    const rss = harnessProcess.value.rss;
    evidence.harnessRssBytes = Math.round(rss);
    if (rss >= 3 * GIB) {
      procSat = 22;
      procDesc = `，DSH 进程膨胀（${formatGiB(rss)}）`;
    } else if (rss >= 1.5 * GIB) {
      procSat = 48;
      procDesc = `，DSH 内存偏高（${formatGiB(rss)}）`;
    } else {
      procDesc = `，DSH 占用 ${formatGiB(rss)}`;
    }
  }

  let jobSat = 100;
  let jobDesc = '';
  if (stuckJobCount >= 3) {
    jobSat = 22;
    jobDesc = `，残留 ${stuckJobCount} 个超时/无主任务`;
  } else if (stuckJobCount >= 1) {
    jobSat = 45;
    jobDesc = `，发现 ${stuckJobCount} 个超时/无主任务`;
  }

  const h = applyHysteresis(Math.min(memSat, procSat, jobSat), prev);
  return {
    key: 'memory',
    label: NEED_LABELS.memory,
    ...h,
    summary: `${memDesc}${procDesc}${jobDesc}`,
    evidence,
    updatedAt: snapshot.now,
  };
}

function evalMind(snapshot: SenseSnapshot, prev?: PreviousNeedState): NeedEvaluation {
  const { tokens } = snapshot.state.self.body;
  const sessionId = snapshot.activeSessionId;
  if (
    tokens.status !== 'ok' ||
    !tokens.value ||
    tokens.value.contextWindow === undefined ||
    tokens.value.contextWindow <= 0 ||
    tokens.value.contextUsed === undefined ||
    !Number.isFinite(tokens.value.contextWindow) ||
    !Number.isFinite(tokens.value.contextUsed)
  ) {
    const sameSessionReadingMissing =
      prev?.driveActive === true &&
      (sessionId !== undefined || tokens.status === 'unknown') &&
      (prev.sessionId === undefined || sessionId === undefined || prev.sessionId === sessionId) &&
      tokens.reason !== '没有活动会话' &&
      tokens.reason !== '会话中尚未收到用量';
    const raw = sameSessionReadingMissing && prev ? holdDriveSat(prev) : 100;
    const h = applyHysteresis(raw, prev);
    return {
      key: 'mind',
      label: NEED_LABELS.mind,
      ...h,
      summary: sameSessionReadingMissing ? '上下文容量读数刷新中，保持上次状态' : '暂无活动上下文容量压力',
      evidence: {
        ...(sessionId
          ? { sessionId }
          : prev?.sessionId && sameSessionReadingMissing
            ? { sessionId: prev.sessionId }
            : {}),
        contextUsed: null,
        contextWindow: null,
      },
      updatedAt: snapshot.now,
    };
  }

  const win = tokens.value.contextWindow;
  const used = Math.max(0, tokens.value.contextUsed);
  const rem = Math.max(0, Math.min(1, 1 - used / win));
  const isFallback = tokens.value.contextWindowSource === 'fallback';

  let raw: number;
  if (isFallback) {
    if (rem > 0.2) {
      raw = 70 + Math.round(((rem - 0.2) / 0.8) * 30);
    } else if (rem > 0.02) {
      raw = 30 + Math.round(((rem - 0.02) / 0.18) * 28);
    } else {
      raw = 18;
    }
  } else if (rem > 0.2) {
    raw = 70 + Math.round(((rem - 0.2) / 0.8) * 30);
  } else if (rem > 0.08) {
    raw = 30 + Math.round(((rem - 0.08) / 0.12) * 28);
  } else {
    raw = Math.round((rem / 0.08) * 24);
  }

  const h = applyHysteresis(raw, prev);
  const remPct = Math.round(rem * 100);
  const sourceTag = isFallback ? '（回退估值）' : '';
  return {
    key: 'mind',
    label: NEED_LABELS.mind,
    ...h,
    summary:
      h.zone === 'comfortable'
        ? `上下文余量 ${remPct}%${sourceTag}`
        : `上下文仅剩 ${remPct}%${sourceTag}，空闲时可压缩整理`,
    evidence: {
      ...(sessionId ? { sessionId } : {}),
      contextUsed: Math.round(used),
      contextWindow: Math.round(win),
      remainingRatio: Number(rem.toFixed(4)),
      windowSource: tokens.value.contextWindowSource ?? 'configured',
    },
    updatedAt: snapshot.now,
  };
}

function evalThermals(snapshot: SenseSnapshot, prev?: PreviousNeedState): NeedEvaluation {
  const { thermal, cpu } = snapshot.state.self.body;
  let thermSat = 95;
  let thermDesc = '设备温度正常';
  const evidence: Record<string, string | number | boolean | null> = {};

  if (thermal.status === 'ok' && thermal.value) {
    evidence.thermalState = thermal.value;
    if (thermal.value === 'critical') {
      thermSat = 12;
      thermDesc = '设备严重过热';
    } else if (thermal.value === 'serious') {
      thermSat = 40;
      thermDesc = '设备温度偏高';
    } else if (thermal.value === 'fair') {
      thermSat = 78;
      thermDesc = '设备温度略高';
    }
  } else if (prev?.driveActive && (thermal.status === 'stale' || thermal.status === 'unknown')) {
    thermSat = holdDriveSat(prev);
    thermDesc = '温控读数暂不可用，保持上次状态';
  }

  let cpuSat = 100;
  let cpuDesc = 'CPU 负载平稳';
  if (cpu.status === 'ok' && cpu.value) {
    const current = Math.max(0, Math.min(1, cpu.value.usage));
    const recentCpu = snapshot.history.cpu.filter((p) => p.at >= snapshot.now - 120_000 && p.at <= snapshot.now);
    const sustained =
      recentCpu.length >= 3 ? recentCpu.reduce((acc, p) => acc + p.value, 0) / recentCpu.length : current;
    evidence.cpuUsage = Number(current.toFixed(4));
    evidence.sustainedCpu = Number(sustained.toFixed(4));

    if (sustained >= 0.92 && current >= 0.9) {
      cpuSat = 20;
      cpuDesc = `CPU 持续满载（${Math.round(current * 100)}%）`;
    } else if (sustained >= 0.8 && current >= 0.75) {
      cpuSat = 45;
      cpuDesc = `CPU 持续高负荷（${Math.round(current * 100)}%）`;
    } else {
      cpuSat = Math.max(70, Math.round(100 - current * 30));
      cpuDesc = `CPU 使用率 ${Math.round(current * 100)}%`;
    }
  }

  const h = applyHysteresis(Math.min(thermSat, cpuSat), prev);
  return {
    key: 'thermals',
    label: NEED_LABELS.thermals,
    ...h,
    summary: `${thermDesc} · ${cpuDesc}`,
    evidence,
    updatedAt: snapshot.now,
  };
}

export function evaluateNeeds(input: EvaluateNeedsInput): EvaluatedNeedsResult {
  const { snapshot, modelConnectivity, stuckJobCount, previous } = input;
  const needs: Record<NeedKey, NeedEvaluation> = {
    energy: evalEnergy(snapshot, modelConnectivity, previous?.energy),
    space: evalSpace(snapshot, previous?.space),
    memory: evalMemory(snapshot, stuckJobCount, previous?.memory),
    mind: evalMind(snapshot, previous?.mind),
    thermals: evalThermals(snapshot, previous?.thermals),
  };

  let overallSatisfaction = 100;
  let overallZone: NeedZone = 'comfortable';
  const activeDrives: NeedKey[] = [];

  for (const key of NEED_KEYS) {
    const n = needs[key];
    if (n.satisfaction < overallSatisfaction) overallSatisfaction = n.satisfaction;
    if (n.zone === 'critical') overallZone = 'critical';
    else if (n.zone === 'uncomfortable' && overallZone !== 'critical') overallZone = 'uncomfortable';
    if (n.driveActive) activeDrives.push(key);
  }

  return {
    now: snapshot.now,
    overallSatisfaction,
    overallUrgency: 100 - overallSatisfaction,
    overallZone,
    activeDrives,
    needs,
  };
}
