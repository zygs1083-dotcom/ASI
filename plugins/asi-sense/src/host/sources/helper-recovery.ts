import type { FactStatus } from '@asi/sense-types';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { BodySource } from './body.ts';
import { helperEvent, type Message, object, validApp } from './helper-events.ts';

export class HelperRecovery {
  constructor(public degraded = false) {}
  waiting = false;
  obsolete = false;
  readonly dirty = new Set<string>();

  request(): boolean {
    if (this.waiting) return false;
    this.waiting = true;
    this.dirty.clear();
    return true;
  }

  delta(event: Message): void {
    if (!this.degraded || !this.waiting) return;
    if (event.type === 'thermal' && ['nominal', 'fair', 'serious', 'critical'].includes(String(event.state)))
      this.dirty.add('thermal');
    const appActivated = event.type === 'app.activated' && validApp(event);
    if (appActivated) this.dirty.add('frontApp');
    if (
      appActivated ||
      event.type === 'hello' ||
      event.type === 'window.focused' ||
      (event.type === 'window.title' && typeof event.title === 'string') ||
      event.type === 'ax.unsupported'
    )
      this.dirty.add('focusedWindow');
  }
}

export function missingSnapshot(event: Message): string[] {
  const app = object(event.frontApp);
  const window = object(event.focusedWindow);
  return [
    ...(!validApp(app) ? ['frontApp'] : []),
    ...(!window || !['ok', 'unknown', 'denied', 'unsupported'].includes(String(window.status))
      ? ['focusedWindow']
      : []),
    ...(!['nominal', 'fair', 'serious', 'critical'].includes(String(event.thermal)) ? ['thermal'] : []),
  ];
}

export function markHelperFacts(
  attention: RuntimeAttention,
  body: BodySource,
  at: number,
  fields: readonly string[],
  status: Extract<FactStatus, 'stale' | 'unknown'>,
): void {
  const state = attention.state();
  for (const [field, path, fact] of [
    ['frontApp', 'env.frontApp', state.env.frontApp],
    ['focusedWindow', 'env.focusedWindow', state.env.focusedWindow],
  ] as const) {
    if (
      !fields.includes(field) ||
      (fact.source.id !== 'helper' && !fact.source.id.startsWith('helper.')) ||
      (status === 'stale' && fact.status === 'unknown')
    )
      continue;
    attention.store.apply({
      id: attention.id(),
      kind: 'fact.updated',
      at,
      source: fact.source,
      subject: path,
      data: { path, value: fact.value, status, ttlMs: fact.ttlMs, preserveSourceStatus: true },
    });
  }
  const fact = state.self.body.thermal;
  if (fields.includes('thermal') && (fact.source.id === 'helper' || fact.source.id.startsWith('helper.'))) {
    body.setThermal({ ...fact, status: status === 'stale' && fact.status === 'unknown' ? 'unknown' : status }, true);
  }
  attention.changed();
}

export async function applyHelperEvent(
  recovery: HelperRecovery,
  raw: Message,
  safe: Message,
  attention: RuntimeAttention,
  body: BodySource,
): Promise<boolean> {
  if (raw.type !== 'snapshot') recovery.delta(raw);
  await helperEvent(safe, attention, body, recovery.degraded, recovery.degraded ? recovery.dirty : undefined);
  if (!recovery.degraded || raw.type !== 'snapshot') return false;
  const missing = missingSnapshot(raw);
  if (missing.length) {
    markHelperFacts(attention, body, raw.at as number, missing, 'unknown');
    return false;
  }
  recovery.degraded = false;
  body.finishThermalRecovery();
  return true;
}
