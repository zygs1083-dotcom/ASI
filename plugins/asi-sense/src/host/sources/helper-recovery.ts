import type { FactStatus } from '@asi/sense-types';
import type { SenseBus } from '../runtime/bus.ts';
import type { BodySource } from './body.ts';
import { appObservation, axStatus, helperEvent, type Message, object, validApp } from './helper-events.ts';

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
    if (!this.waiting) return;
    if (event.type === 'hello') this.dirty.add('permissions');
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
  const empty = !Object.hasOwn(event, 'frontApp') && !Object.hasOwn(event, 'focusedWindow');
  return [
    ...(!empty && !validApp(app) ? ['frontApp'] : []),
    ...(!empty && (!window || !['ok', 'unknown', 'denied', 'unsupported'].includes(String(window.status)))
      ? ['focusedWindow']
      : []),
    ...(!['nominal', 'fair', 'serious', 'critical'].includes(String(event.thermal)) ? ['thermal'] : []),
  ];
}

export function markHelperFacts(
  bus: SenseBus,
  body: BodySource,
  at: number,
  fields: readonly string[],
  status: Extract<FactStatus, 'stale' | 'unknown'>,
): void {
  const state = bus.state();
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
    bus.store.apply({
      id: bus.id(),
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
  bus.changed();
}

export async function applyHelperEvent(
  recovery: HelperRecovery,
  raw: Message,
  safe: Message,
  bus: SenseBus,
  body: BodySource,
  valid: () => boolean = () => true,
  skip: ReadonlySet<string> = new Set(),
  metadataOnly = false,
): Promise<boolean> {
  if (raw.type !== 'snapshot') recovery.delta(raw);
  if (raw.type === 'snapshot' && metadataOnly) {
    const app = object(safe.frontApp);
    const state = bus.state();
    const current = state.env.frontApp.value;
    const window = object(raw.focusedWindow);
    const permission = object(raw.permissions)?.accessibility;
    const sameApp =
      validApp(app) &&
      current &&
      app.bundleId === current.bundleId &&
      (current.pid === undefined || app.pid === current.pid);
    if (sameApp && !recovery.dirty.has('frontApp')) {
      const observed = { ...app };
      if (
        permission === 'denied' ||
        window?.status === 'denied' ||
        window?.status === 'unsupported' ||
        (state.observation.sources['helper.ax']?.status === 'denied' && permission !== 'granted')
      )
        delete observed.windowCount;
      await appObservation(bus, observed, raw.at as number, false, valid);
    }
    if (!valid()) return false;
    if (!recovery.dirty.has('permissions')) {
      const state = bus.state();
      const currentStatus = state.observation.sources['helper.ax']?.status;
      const status =
        permission === 'denied'
          ? 'denied'
          : recovery.dirty.has('focusedWindow')
            ? undefined
            : sameApp && window?.status === 'denied'
              ? 'denied'
              : sameApp && window?.status === 'unsupported'
                ? 'unsupported'
                : sameApp &&
                    (currentStatus !== 'denied' || permission === 'granted') &&
                    (window?.status === 'ok' ||
                      (state.env.focusedWindow.status !== 'unknown' &&
                        Number.isSafeInteger(app.windowCount) &&
                        (app.windowCount as number) >= 0))
                  ? 'ok'
                  : undefined;
      if (status && (status !== currentStatus || (status === 'denied' && state.env.focusedWindow.status !== 'denied')))
        await axStatus(bus, status, raw.at as number);
    }
    if (!valid()) return false;
  }
  if (raw.type === 'snapshot' && !Object.hasOwn(raw, 'frontApp') && !Object.hasOwn(raw, 'focusedWindow')) {
    for (const [field, path] of [
      ['frontApp', 'env.frontApp'],
      ['focusedWindow', 'env.focusedWindow'],
    ] as const) {
      if (recovery.dirty.has(field) || skip.has(field)) continue;
      bus.store.apply({
        id: bus.id(),
        kind: 'fact.updated',
        at: raw.at as number,
        source: { id: `helper.${field}`, api: 'ndjson', host: 'local' },
        subject: path,
        data: { path, value: null, status: 'ok', ttlMs: 60_000, preserveSourceStatus: recovery.degraded },
      });
    }
    bus.changed();
  }
  if (
    raw.type === 'snapshot' &&
    !metadataOnly &&
    (recovery.dirty.has('focusedWindow') || skip.has('focusedWindow')) &&
    !recovery.dirty.has('permissions') &&
    !skip.has('permissions') &&
    object(raw.permissions)?.accessibility === 'denied'
  ) {
    await axStatus(bus, 'denied', raw.at as number);
    if (!valid()) return false;
  }
  await helperEvent(
    safe,
    bus,
    body,
    recovery.degraded,
    raw.type === 'snapshot' ? new Set([...recovery.dirty, ...skip]) : undefined,
    valid,
  );
  if (!valid()) return false;
  if (!recovery.degraded || raw.type !== 'snapshot') return false;
  const missing = missingSnapshot(raw);
  if (missing.length) {
    markHelperFacts(bus, body, raw.at as number, missing, 'unknown');
    return false;
  }
  recovery.degraded = false;
  body.finishThermalRecovery();
  return true;
}
