import type { SamplingCadence, StartOptions } from '@asi/body-probe';
import type { Body, Fact } from '@asi/sense-types';
import type { SenseBus } from '../runtime/bus.ts';
import type { FactExpiry } from '../runtime/expiry.ts';
import type { Clock, DshPort, ProbeFactory } from '../runtime/ports.ts';
import { TokenFacts } from './token-facts.ts';

type ObservationTimes = Record<string, { wall: number; mono: number }>;

const ECO_CADENCE: Partial<SamplingCadence> = {
  memoryMs: 15_000,
  networkMs: 15_000,
  pressureMs: 15_000,
  swapMs: 60_000,
  routeMs: 60_000,
  batteryMs: 60_000,
  disksMs: 30_000,
};

function captureObservationTimes(body: Body, mono: number, at: number, previous: ObservationTimes): ObservationTimes {
  const next: ObservationTimes = { ...previous };
  const track = (key: string, status: string, observedAt: number | undefined) => {
    if (status !== 'ok' || observedAt === undefined || !Number.isFinite(observedAt)) return;
    if (previous[key]?.wall !== observedAt) {
      next[key] = { wall: observedAt, mono: mono - Math.max(0, at - observedAt) };
    }
  };
  track('cpu', body.cpu.status, body.cpu.observedAt);
  track('memory', body.memory.status, body.memory.observedAt);
  track('battery', body.battery.status, body.battery.observedAt);
  track('network.rx', body.network.status, body.network.observedAt);
  track('rss', body.harnessProcess.status, body.harnessProcess.observedAt);
  for (const disk of body.disks.value ?? []) {
    track(`disk:${disk.mount}`, disk.status ?? body.disks.status, disk.observedAt ?? body.disks.observedAt);
  }
  return next;
}

export class BodySource {
  private readonly probe: ReturnType<ProbeFactory['create']>;
  private tail = Promise.resolve();
  private off?: () => void;
  private stopped = false;
  private intervalMs = 2_000;
  private eco = false;
  private sampling = false;
  private readonly tokenFacts: TokenFacts;
  private thermal?: Body['thermal'];
  private thermalRecovering = false;
  private observationTimes: ObservationTimes = {};
  private contextSession?: string;

  constructor(
    factory: ProbeFactory,
    dsh: DshPort,
    private readonly clock: Clock,
    private readonly bus: SenseBus,
    private readonly expiry: FactExpiry,
    private readonly paused: () => boolean,
    private readonly changed: () => void,
    private readonly onBodySample?: (body: Body, at: number, mono: number) => void,
  ) {
    this.probe = factory.create();
    this.tokenFacts = new TokenFacts(
      dsh,
      clock,
      () => bus.state().self.body.tokens,
      (fact, mono) => {
        if (mono === undefined) this.write('tokens', fact);
        else
          this.expiry.withObservationTimes({ context: { wall: fact.observedAt, mono } }, () =>
            this.write('tokens', fact),
          );
      },
      changed,
    );
  }

  private startOptions(): StartOptions {
    return {
      intervalMs: this.intervalMs,
      ...(this.eco ? { cadence: ECO_CADENCE } : {}),
    };
  }

  async start(intervalMs: number): Promise<void> {
    if (this.stopped) return;
    this.off = this.probe.onSample((body) => {
      const at = this.clock.wall();
      const mono = this.clock.mono();
      const sessionId = this.bus.currentSessionId();
      const tokens = this.tokenFacts.hasReading ? this.bus.state().self.body.tokens : undefined;
      const tokenTime = tokens && this.expiry.factMeta('/self/body/tokens');
      this.enqueue(() => this.sample(body, at, mono, { sessionId, tokens, tokenTime }));
    });
    this.intervalMs = intervalMs;
    await this.setPaused(this.paused());
  }

  async setPaused(paused: boolean): Promise<void> {
    if (paused) this.tokenFacts.pause();
    if (paused && this.sampling) {
      this.sampling = false;
      await this.probe.stop();
    } else if (!paused && !this.sampling && !this.stopped) {
      this.sampling = true;
      this.probe.start(this.startOptions());
    }
  }

  async setIntervalMs(intervalMs: number, eco = false): Promise<void> {
    if (this.intervalMs === intervalMs && this.eco === eco) return;
    this.intervalMs = intervalMs;
    this.eco = eco;
    if (this.sampling && !this.stopped && !this.paused()) {
      this.sampling = false;
      await this.probe.stop();
      if (!this.stopped && !this.paused()) {
        this.sampling = true;
        this.probe.start(this.startOptions());
      }
    }
  }

  sessionsChanged(present: boolean): void {
    this.tokenFacts.sessionsChanged(present);
  }

  tokens(session: string, valid: () => boolean = () => true): Promise<void> {
    return this.tokenFacts.tokens(session, valid);
  }

  sessionToken(session: string): Body['tokens'] {
    return this.tokenFacts.fact(session);
  }

  selectSession(session?: string): void {
    this.tokenFacts.select(session);
  }

  disposeSession(session: string): void {
    this.tokenFacts.dispose(session);
  }

  setThermal(fact: Body['thermal'], recovering = false): void {
    if (this.stopped) return;
    this.thermal = fact;
    this.thermalRecovering = recovering;
    this.write('thermal', fact);
    this.changed();
  }

  finishThermalRecovery(): void {
    this.thermalRecovering = false;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const tokens = this.tokenFacts.stop();
    this.off?.();
    if (this.sampling) await this.probe.stop();
    this.sampling = false;
    await Promise.allSettled([this.tail]);
    await tokens;
  }

  private enqueue(work: () => Promise<void>): void {
    const run = this.tail.then(work);
    this.tail = run.catch(() => {});
  }

  private write(key: keyof Body, fact: Fact<unknown>): void {
    if (this.stopped) return;
    this.bus.store.apply({
      id: this.bus.id(),
      kind: 'fact.updated',
      at: fact.observedAt,
      source: fact.source,
      subject: `self.body.${key}`,
      data: {
        path: `self.body.${key}`,
        value: fact.value,
        status: fact.status,
        ttlMs: fact.ttlMs,
        ...(fact.reason === undefined ? {} : { reason: fact.reason }),
        ...(key === 'thermal' && this.thermalRecovering ? { preserveSourceStatus: true } : {}),
        ...('unavailableMounts' in fact ? { unavailableMounts: fact.unavailableMounts } : {}),
      },
    });
  }

  private async sample(
    body: Body,
    at: number,
    mono: number,
    captured: {
      sessionId?: string;
      tokens?: Body['tokens'];
      tokenTime?: ReturnType<FactExpiry['factMeta']>;
    },
  ): Promise<void> {
    if (this.stopped || this.paused()) return;
    const { sessionId, tokens, tokenTime } = captured;
    const current = this.thermal ? this.bus.state().self.body : undefined;
    const next = structuredClone(body);
    if (tokens) next.tokens = tokens;
    if (this.thermal && current) next.thermal = current.thermal;
    if (this.contextSession !== sessionId) {
      delete this.observationTimes.context;
      this.contextSession = sessionId;
    }
    if (tokenTime && tokens?.status === 'ok') {
      this.observationTimes.context = { wall: tokens.observedAt, mono: tokenTime.observedMono };
    }
    this.observationTimes = captureObservationTimes(next, mono, at, this.observationTimes);
    this.onBodySample?.(next, at, mono);
    this.expiry.withObservationTimes(this.observationTimes, () =>
      this.bus.batch(
        () => {
          for (const key of Object.keys(body) as (keyof Body)[]) {
            if ((key === 'tokens' && tokens) || (key === 'thermal' && this.thermal)) continue;
            this.write(key, key === 'tokens' ? this.tokenFacts.decorate(body.tokens) : body[key]);
          }
          this.changed();
        },
        () => {},
      ),
    );
  }
}
