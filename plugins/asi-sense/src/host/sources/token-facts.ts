import type { Body, Fact } from '@asi/sense-types';
import type { Clock, DshPort, TokenSnapshot } from '../runtime/ports.ts';

type TokenFact = Fact<NonNullable<Body['tokens']['value']>>;

export class TokenFacts {
  private token?: TokenFact;
  private tokenSource?: TokenSnapshot['contextWindowSource'];
  private readonly readings = new Map<
    string,
    { fact: TokenFact; source: TokenSnapshot['contextWindowSource']; mono: number }
  >();
  private readonly generations = new Map<string, object>();
  private selected?: string;
  private readonly tokenWork = new Set<Promise<void>>();
  private stopped = false;
  private hasSession = false;
  private initialized = false;

  constructor(
    private readonly dsh: DshPort,
    private readonly clock: Clock,
    private readonly current: () => TokenFact,
    private readonly write: (fact: TokenFact, observedMono?: number) => void,
    private readonly changed: () => void,
    private readonly ttlMs: () => number = () => 15_000,
  ) {}

  get hasReading(): boolean {
    return this.token !== undefined;
  }

  get source(): TokenSnapshot['contextWindowSource'] {
    return this.tokenSource;
  }

  private reason(): string {
    return this.hasSession ? '会话中尚未收到用量' : '没有活动会话';
  }

  sessionsChanged(present: boolean): void {
    if (this.stopped) return;
    if (this.initialized && this.hasSession === present) return;
    this.initialized = true;
    this.hasSession = present;
    const current = this.current();
    if ((current.status !== 'unknown' && current.status !== 'unavailable') || current.reason === this.reason()) return;
    const fact = { ...current, reason: this.reason() };
    if (this.token) this.token = fact;
    this.write(fact);
    this.changed();
  }

  decorate(fact: TokenFact): TokenFact {
    if (
      (fact.status === 'unknown' || fact.status === 'unavailable') &&
      (!fact.reason || fact.reason === '未接入用量来源')
    )
      return { ...fact, reason: this.reason() };
    return fact;
  }

  fact(session: string): TokenFact {
    const reading = this.readings.get(session);
    if (!reading) return this.empty();
    const fact = structuredClone(reading.fact);
    if (fact.status === 'ok' && this.clock.mono() - reading.mono >= fact.ttlMs) fact.status = 'stale';
    return fact;
  }

  private empty(): TokenFact {
    return {
      value: null,
      status: 'unknown',
      source: { id: 'tokens', api: 'dsh', host: 'local' },
      observedAt: this.clock.wall(),
      ttlMs: this.ttlMs(),
      reason: this.reason(),
    };
  }

  select(session?: string): void {
    if (this.stopped || this.selected === session) return;
    this.selected = session;
    const reading = session ? this.readings.get(session) : undefined;
    this.token = reading ? this.fact(session as string) : this.empty();
    this.tokenSource = reading?.source;
    const ttlMs = reading ? Math.max(0, this.token.ttlMs - (this.clock.mono() - reading.mono)) : this.token.ttlMs;
    this.write({ ...this.token, ttlMs }, reading?.mono);
    this.changed();
  }

  dispose(session: string): void {
    this.readings.delete(session);
    this.generations.delete(session);
  }

  tokens(session: string, valid: () => boolean = () => true): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const work = this.readTokens(session, valid);
    this.tokenWork.add(work);
    void work.then(
      () => this.tokenWork.delete(work),
      () => this.tokenWork.delete(work),
    );
    return work;
  }

  private async readTokens(session: string, valid: () => boolean): Promise<void> {
    const generation = {};
    this.generations.set(session, generation);
    let failed = false;
    const snapshot = await Promise.resolve()
      .then(() => this.dsh.tokenSnapshot(session))
      .catch(() => {
        failed = true;
        return undefined;
      });
    if (this.stopped || this.generations.get(session) !== generation || !valid()) return;
    const fact: TokenFact = {
      value: snapshot ?? null,
      status: snapshot ? 'ok' : 'unavailable',
      source: { id: 'tokens', api: 'dsh', host: 'local' },
      observedAt: this.clock.wall(),
      ttlMs: this.ttlMs(),
      ...(!snapshot ? { reason: failed && this.hasSession ? '用量读取失败' : this.reason() } : {}),
    };
    this.readings.set(session, { fact, source: snapshot?.contextWindowSource, mono: this.clock.mono() });
    if (this.selected === session) {
      this.token = fact;
      this.tokenSource = snapshot?.contextWindowSource;
      this.write(fact, this.clock.mono());
      this.changed();
    }
  }

  pause(): void {
    this.generations.clear();
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.allSettled([...this.tokenWork]).then(() => {});
  }
}
