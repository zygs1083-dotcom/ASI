/**
 * Tier 1: Zero-Token Instinct Reflexes.
 * - Immediately switches `asi-sense` sampling into `'eco'` mode on unplugged
 *   low battery, thermal pressure, sustained CPU overload, or gateway offline;
 *   restores `'normal'` only when comfortable and drives have cleared (and only
 *   when instinct itself enabled `'eco'`).
 * - Performs silent zero-token HTTP HEAD liveness checks against the configured
 *   model endpoint with exponential backoff (never sends credentials or LLM
 *   completion requests, and strictly refuses forbidden production hosts).
 */

import type {
  AsiSenseServiceApi,
  InstinctState,
  ModelConnectivity,
  NeedEvaluation,
  NeedKey,
  PowerMode,
  SenseSnapshot,
} from '@asi/sense-types';

export type EndpointProbe = (endpoint: string, signal: AbortSignal) => Promise<boolean>;

const ONLINE_PROBE_INTERVAL_MS = 60_000;
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

const FORBIDDEN_TUNNEL_PORTS = new Set(['19030', '18030', '12345', '12234', '12235', '13306']);

function isForbiddenEndpoint(url: URL): boolean {
  const lower = url.hostname.toLowerCase();
  if (lower === '192.168.0.35' || lower === '192.168.0.34') return true;
  const isLoopback = lower === 'localhost' || lower === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(lower);
  return isLoopback && FORBIDDEN_TUNNEL_PORTS.has(url.port);
}

export const defaultEndpointProbe: EndpointProbe = async (endpoint, signal) => {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || isForbiddenEndpoint(url)) {
    return true;
  }
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
  try {
    try {
      const head = await fetch(url.href, {
        method: 'HEAD',
        redirect: 'manual',
        signal: ac.signal,
      });
      if (head.status < 500) return true;
    } catch {
      // Fallback to zero-body GET for gateways/proxies that reject or drop HEAD
    }
    if (ac.signal.aborted) return false;
    const getRes = await fetch(url.href, {
      method: 'GET',
      redirect: 'manual',
      signal: ac.signal,
    });
    await getRes.body?.cancel().catch(() => undefined);
    return getRes.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
};

export interface InstinctReflexResult {
  changed: boolean;
  powerChanged?: { from: PowerMode; to: PowerMode; reason?: string };
  connectivityChanged?: { from: ModelConnectivity; to: ModelConnectivity };
}

export class InstinctController {
  private connectivity: ModelConnectivity = 'online';
  private consecutiveFailures = 0;
  private probeCount = 0;
  private lastProbeAt?: number;
  private nextProbeAt?: number;
  private lastProbeError?: string;
  private probing = false;
  private instinctOwnedEco = false;
  private abortController = new AbortController();

  constructor(
    private readonly sense: Pick<AsiSenseServiceApi, 'getSettings' | 'setPowerMode'>,
    private readonly probe: EndpointProbe = defaultEndpointProbe,
  ) {}

  state(): InstinctState {
    const settings = this.sense.getSettings();
    return {
      powerMode: settings.powerMode,
      ...(settings.powerModeReason ? { powerReason: settings.powerModeReason } : {}),
      modelConnectivity: this.connectivity,
      probeCount: this.probeCount,
      ...(this.lastProbeAt !== undefined ? { lastProbeAt: this.lastProbeAt } : {}),
      ...(this.nextProbeAt !== undefined ? { nextProbeAt: this.nextProbeAt } : {}),
      ...(this.lastProbeError ? { lastProbeError: this.lastProbeError } : {}),
    };
  }

  modelConnectivity(): ModelConnectivity {
    return this.connectivity;
  }

  reportTransportResult(reachable: boolean, now: number, errorText?: string): boolean {
    const prev = this.connectivity;
    if (reachable) {
      this.consecutiveFailures = 0;
      this.connectivity = 'online';
      this.lastProbeError = undefined;
      this.nextProbeAt = now + ONLINE_PROBE_INTERVAL_MS;
    } else {
      this.consecutiveFailures += 1;
      this.connectivity = this.consecutiveFailures >= 2 ? 'offline' : 'degraded';
      this.lastProbeError = errorText ?? 'gateway unreachable';
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, this.consecutiveFailures - 1));
      this.nextProbeAt = now + backoff;
    }
    return prev !== this.connectivity;
  }

  async probeConnectivity(
    snapshot: SenseSnapshot,
    paused: boolean,
  ): Promise<InstinctReflexResult['connectivityChanged']> {
    if (paused) return undefined;

    const endpointFact = snapshot.state.env.where.model;
    const netFact = snapshot.state.self.body.network;
    const endpoint = endpointFact.status === 'ok' ? endpointFact.value?.endpoint : undefined;
    const isRemote = endpointFact.status === 'ok' && endpointFact.value?.local === false;

    if (isRemote && netFact.status === 'ok' && netFact.value?.online === false) {
      const prev = this.connectivity;
      if (prev !== 'offline') {
        this.connectivity = 'offline';
        this.consecutiveFailures = Math.max(2, this.consecutiveFailures);
        this.lastProbeError = '本地网络已断开';
        return { from: prev, to: 'offline' };
      }
      return undefined;
    }

    if (endpoint && !this.probing && (this.nextProbeAt === undefined || snapshot.now >= this.nextProbeAt)) {
      this.probing = true;
      const prev = this.connectivity;
      try {
        const ok = await this.probe(endpoint, this.abortController.signal);
        this.probeCount += 1;
        this.lastProbeAt = snapshot.now;
        if (this.reportTransportResult(ok, snapshot.now, ok ? undefined : '网关探活无响应')) {
          return { from: prev, to: this.connectivity };
        }
      } finally {
        this.probing = false;
      }
    }
    return undefined;
  }

  async reconcilePower(
    snapshot: SenseSnapshot,
    needs: Record<NeedKey, NeedEvaluation>,
    paused: boolean,
  ): Promise<InstinctReflexResult['powerChanged']> {
    if (paused) return undefined;

    const ecoReason = this.computeEcoReason(snapshot, needs);
    const currentSettings = this.sense.getSettings();
    if (currentSettings.powerMode === 'normal') {
      this.instinctOwnedEco = false;
    }

    if (ecoReason) {
      this.instinctOwnedEco = true;
      if (currentSettings.powerMode !== 'eco' || currentSettings.powerModeReason !== ecoReason) {
        const from = currentSettings.powerMode;
        await this.sense.setPowerMode('eco', ecoReason);
        if (from !== 'eco') {
          return { from, to: 'eco', reason: ecoReason };
        }
      }
      return undefined;
    }

    if (
      this.instinctOwnedEco &&
      currentSettings.powerMode === 'eco' &&
      !needs.energy.driveActive &&
      !needs.thermals.driveActive
    ) {
      this.instinctOwnedEco = false;
      await this.sense.setPowerMode('normal');
      return { from: 'eco', to: 'normal' };
    }
    return undefined;
  }

  async reconcile(
    snapshot: SenseSnapshot,
    needs: Record<NeedKey, NeedEvaluation>,
    paused: boolean,
  ): Promise<InstinctReflexResult> {
    const connectivityChanged = await this.probeConnectivity(snapshot, paused);
    const powerChanged = await this.reconcilePower(snapshot, needs, paused);
    return {
      changed: Boolean(powerChanged || connectivityChanged),
      ...(powerChanged ? { powerChanged } : {}),
      ...(connectivityChanged ? { connectivityChanged } : {}),
    };
  }

  private computeEcoReason(snapshot: SenseSnapshot, needs: Record<NeedKey, NeedEvaluation>): string | undefined {
    const bat = snapshot.state.self.body.battery;
    if (bat.status === 'ok' && bat.value) {
      const plugged =
        bat.value.charging === true ||
        bat.value.powerState === 'charging' ||
        bat.value.powerState === 'charged' ||
        bat.value.powerState === 'external';
      const lowMinutes =
        bat.value.minutesLeft !== undefined &&
        Number.isFinite(bat.value.minutesLeft) &&
        bat.value.minutesLeft > 0 &&
        bat.value.minutesLeft <= 15;
      if (!plugged && (bat.value.percent <= 20 || lowMinutes)) {
        return lowMinutes && bat.value.percent > 20
          ? `电池剩余续航不足 ${Math.ceil(bat.value.minutesLeft ?? 15)} 分钟自动降频省电`
          : `电池低电量（${Math.round(bat.value.percent)}%）自动降频省电`;
      }
    }
    const therm = snapshot.state.self.body.thermal;
    if (therm.status === 'ok' && (therm.value === 'serious' || therm.value === 'critical')) {
      return `设备温控${therm.value === 'critical' ? '严重过热' : '偏高'}自动降频降温`;
    }
    if (needs.thermals.zone !== 'comfortable') {
      return '持续高负荷自动降频降温';
    }
    if (this.connectivity === 'offline') {
      return '模型网关失联期间静默降频';
    }
    return undefined;
  }

  stop(): void {
    this.abortController.abort();
    this.abortController = new AbortController();
  }
}
