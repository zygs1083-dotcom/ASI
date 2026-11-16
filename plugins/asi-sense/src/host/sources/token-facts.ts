import type { Body, Fact } from '@asi/sense-types';
import type { Clock, DshPort, TokenSnapshot } from '../runtime/ports.ts';

type TokenFact = Fact<NonNullable<Body['tokens']['value']>>;

export class TokenFacts {
  private token?: TokenFact;
  private tokenSource?: TokenSnapshot['contextWindowSource'];
  private tokenGeneration = 0;
  private readonly tokenWork = new Set<Promise<void>>();
  private stopped = false;
  private hasSession = false;
  private initialized = false;

  constructor(
    private readonly dsh: DshPort,
    private readonly clock: Clock,
    private readonly current: () => TokenFact,
    private readonly write: (fact: TokenFact) => void,
    private readonly changed: () => void,
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
    const generation = ++this.tokenGeneration;
    let failed = false;
    const snapshot = await Promise.resolve()
      .then(() => this.dsh.tokenSnapshot(session))
      .catch(() => {
        failed = true;
        return undefined;
      });
    if (this.stopped || generation !== this.tokenGeneration || !valid()) return;
    this.tokenSource = snapshot?.contextWindowSource;
    this.token = {
      value: snapshot ?? null,
      status: snapshot ? 'ok' : 'unavailable',
      source: { id: 'tokens', api: 'dsh', host: 'local' },
      observedAt: this.clock.wall(),
      ttlMs: 15_000,
      ...(!snapshot ? { reason: failed && this.hasSession ? '用量读取失败' : this.reason() } : {}),
    };
    this.write(this.token);
    this.changed();
  }

  pause(): void {
    this.tokenGeneration++;
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.allSettled([...this.tokenWork]).then(() => {});
  }
}
