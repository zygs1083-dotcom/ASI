import type { Body, SourceRef } from '@asi/sense-types';
import type { SenseBus } from '../runtime/bus.ts';
import type { BodySource } from './body.ts';

export const source: SourceRef = { id: 'helper', api: 'ndjson', host: 'local' };
export const ax: SourceRef = { id: 'helper.ax', api: 'accessibility', host: 'local' };
export type Message = Record<string, unknown>;

type SystemSlot = 'sleepAt' | 'lockedAt' | 'inactiveAt';
interface SystemTracker {
  sleepAt?: number;
  lockedAt?: number;
  inactiveAt?: number;
}
interface SystemEventSpec {
  kind: 'system.sleep' | 'system.wake' | 'screen.locked' | 'screen.unlocked' | 'session.active' | 'session.inactive';
  subject: 'system' | 'screen' | 'session';
  slot: SystemSlot;
  phase: 'start' | 'end';
}

const SYSTEM_EVENT_SPECS: Readonly<Record<string, SystemEventSpec>> = {
  'power.sleep': { kind: 'system.sleep', subject: 'system', slot: 'sleepAt', phase: 'start' },
  'power.wake': { kind: 'system.wake', subject: 'system', slot: 'sleepAt', phase: 'end' },
  'screen.locked': { kind: 'screen.locked', subject: 'screen', slot: 'lockedAt', phase: 'start' },
  'screen.unlocked': { kind: 'screen.unlocked', subject: 'screen', slot: 'lockedAt', phase: 'end' },
  'session.inactive': { kind: 'session.inactive', subject: 'session', slot: 'inactiveAt', phase: 'start' },
  'session.active': { kind: 'session.active', subject: 'session', slot: 'inactiveAt', phase: 'end' },
};

const systemTrackers = new WeakMap<SenseBus, SystemTracker>();

function getSystemTracker(bus: SenseBus): SystemTracker {
  let tracker = systemTrackers.get(bus);
  if (!tracker) {
    tracker = {};
    systemTrackers.set(bus, tracker);
  }
  return tracker;
}

export function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'title')
      .map(([key, v]) => [key, strip(v)]),
  );
}
export function object(value: unknown): Message | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Message) : undefined;
}
export function validApp(value: Message | undefined): value is Message {
  return value !== undefined && typeof value.name === 'string' && typeof value.bundleId === 'string';
}
export function clearWindow(bus: SenseBus, at: number): void {
  if (bus.isStopped()) return;
  bus.store.apply({
    id: bus.id(),
    kind: 'fact.updated',
    at,
    source: { ...ax, id: 'helper.window' },
    subject: 'env.focusedWindow',
    data: { path: 'env.focusedWindow', value: null, status: 'unknown' },
  });
  bus.changed();
}
export async function helperStatus(
  bus: SenseBus,
  at: number,
  status: 'ok' | 'unavailable' | 'error',
  reason: string,
  restarts: number,
  lastFailure?: string,
): Promise<void> {
  if (status !== 'ok' && !bus.isStopped()) {
    permissionUnknown(bus, at);
  }
  await bus.accept({
    id: bus.id(),
    kind: 'source.status',
    at,
    source,
    subject: source.id,
    data: {
      status,
      reason,
      restarts,
      lastFailure,
      ...(status === 'error' ? { error: reason } : {}),
    },
  });
}
export function permissionUnknown(bus: SenseBus, at: number): void {
  if (bus.isStopped()) return;
  bus.store.apply({
    id: bus.id(),
    kind: 'fact.updated',
    at,
    source: ax,
    subject: 'self.permissions',
    data: {
      path: 'self.permissions',
      value: null,
      status: 'unknown',
      reason: '辅助功能状态不可用',
      ttlMs: 60_000,
      preserveSourceStatus: true,
    },
  });
  bus.changed();
}
export async function helperError(bus: SenseBus, event: Message): Promise<string> {
  const code = typeof event.code === 'string' ? event.code : 'protocol-error';
  await bus.accept({
    id: bus.id(),
    kind: 'source.error',
    at: event.at as number,
    source,
    subject: source.id,
    data: { error: code, dropped: event.dropped, droppedTypes: event.droppedTypes },
  });
  return code;
}
export function permissionStatus(bus: SenseBus, status: 'granted' | 'denied', at: number): void {
  if (bus.isStopped()) return;
  bus.store.apply({
    id: bus.id(),
    kind: 'fact.updated',
    at,
    source: ax,
    subject: 'self.permissions',
    data: {
      path: 'self.permissions',
      value: { 辅助功能: status, '其他权限（DSH 未提供）': 'unknown' },
      status: 'ok',
      ttlMs: 60_000,
      preserveSourceStatus: true,
    },
  });
  bus.changed();
}
export async function axStatus(
  bus: SenseBus,
  status: 'ok' | 'denied' | 'unsupported' | 'unknown',
  at: number,
  reason?: string,
): Promise<void> {
  if (bus.isStopped()) return;
  const previous = bus.state().env.focusedWindow.status;
  if (status !== 'ok' || previous === 'denied' || previous === 'unsupported') {
    bus.store.apply({
      id: bus.id(),
      kind: 'fact.updated',
      at,
      source: { ...ax, id: 'helper.window' },
      subject: 'env.focusedWindow',
      data: { path: 'env.focusedWindow', value: null, status: status === 'ok' ? 'unknown' : status },
    });
  }
  await bus.accept({
    id: bus.id(),
    kind: 'source.status',
    at,
    source: ax,
    subject: ax.id,
    data: reason === undefined ? { status } : { status, reason },
  });
}

/**
 * True when an `ax-retryable` error's wire identity names the exact current
 * foreground app process. Both wire and current state must carry a positive
 * integer pid so background multi-instance apps sharing a bundleId can never
 * cross-clear the foreground window.
 */
export function axRetryableTarget(
  event: Message,
  current: { bundleId: string; pid?: number } | null | undefined,
): boolean {
  if (!current || current.pid === undefined) return false;
  const bundleId = event.bundleId;
  if (typeof bundleId !== 'string') return false;
  const pid = Number.isSafeInteger(event.pid) && (event.pid as number) > 0 ? (event.pid as number) : undefined;
  if (pid === undefined) return false;
  return bundleId === current.bundleId && pid === current.pid;
}

export async function appObservation(
  bus: SenseBus,
  app: Message,
  at: number,
  recovering = false,
  valid: () => boolean = () => true,
): Promise<void> {
  if (!validApp(app) || bus.isStopped()) return;
  const previous = bus.state().env.frontApp.value;
  const pid = Number.isSafeInteger(app.pid) && (app.pid as number) > 0 ? (app.pid as number) : undefined;
  const sameBundle = previous?.bundleId === app.bundleId;
  const sameProcess = sameBundle && (previous?.pid === undefined || pid === undefined || previous.pid === pid);
  if (!sameProcess && bus.state().observation.sources['helper.ax']?.status !== 'denied') {
    await axStatus(bus, 'unknown', at);
    if (!valid() || bus.isStopped()) return;
  }
  if (!sameProcess) {
    await bus.accept({
      id: bus.id(),
      kind: 'app.activated',
      at,
      source,
      subject: app.bundleId as string,
      data: recovering ? { ...app, preserveSourceStatus: true } : app,
    });
    return;
  }
  const value = {
    name: app.name,
    bundleId: app.bundleId,
    ...(pid !== undefined ? { pid } : {}),
    ...(Number.isSafeInteger(app.windowCount) && (app.windowCount as number) >= 0
      ? { windowCount: app.windowCount }
      : {}),
  };
  bus.store.apply({
    id: bus.id(),
    kind: 'fact.updated',
    at,
    source,
    subject: 'env.frontApp',
    data: { path: 'env.frontApp', value, status: 'ok', preserveSourceStatus: recovering },
  });
  bus.changed();
}
export async function helperEvent(
  event: Message,
  bus: SenseBus,
  body: BodySource,
  recovering = false,
  skip: ReadonlySet<string> = new Set(),
  valid: () => boolean = () => true,
): Promise<void> {
  if (bus.isStopped()) return;
  const at = event.at as number;
  const emit = async (kind: string, data: Message) => {
    await bus.accept({
      id: bus.id(),
      kind,
      at,
      source: kind.startsWith('window') ? ax : source,
      subject: typeof data.bundleId === 'string' ? data.bundleId : 'helper',
      data: recovering ? { ...data, preserveSourceStatus: true } : data,
    });
  };
  if (event.type === 'thermal' && ['unknown', 'nominal', 'fair', 'serious', 'critical'].includes(String(event.state))) {
    body.setThermal(
      {
        value: event.state === 'unknown' ? null : (event.state as Body['thermal']['value']),
        status: event.state === 'unknown' ? 'unknown' : 'ok',
        source,
        observedAt: at,
        ttlMs: 60_000,
      },
      recovering,
    );
  } else if (event.type === 'snapshot') {
    const app = object(event.frontApp);
    if (validApp(app) && !skip.has('frontApp')) await appObservation(bus, app, at, recovering, valid);
    if (!valid()) return;
    const permission = !skip.has('permissions') ? object(event.permissions)?.accessibility : undefined;
    const window = object(event.focusedWindow);
    if (!skip.has('focusedWindow')) {
      if (permission === 'denied' || window?.status === 'denied') await axStatus(bus, 'denied', at);
      else if (window?.status === 'unsupported') await axStatus(bus, 'unsupported', at);
      else if (window?.status === 'ok' && typeof window.title === 'string') await emit('window.focused', window);
      else if (window?.status === 'ok') {
        clearWindow(bus, at);
        await axStatus(bus, 'ok', at);
      } else if (window) clearWindow(bus, at);
    }
    if (!valid()) return;
    if (!skip.has('thermal') && ['nominal', 'fair', 'serious', 'critical'].includes(String(event.thermal))) {
      body.setThermal(
        { value: event.thermal as Body['thermal']['value'], status: 'ok', source, observedAt: at, ttlMs: 60_000 },
        recovering,
      );
    }
  } else if (event.type === 'ax.unsupported') {
    const current = bus.state().env.frontApp.value;
    if (
      current &&
      ((typeof event.bundleId === 'string' && event.bundleId !== current.bundleId) ||
        (current.pid !== undefined && typeof event.pid === 'number' && event.pid !== current.pid))
    )
      return;
    await axStatus(bus, 'unsupported', at);
  } else if (event.type === 'app.activated' || event.type === 'app.launched' || event.type === 'app.terminated') {
    if (event.type === 'app.activated' && !validApp(event)) return;
    if (
      recovering &&
      event.type === 'app.activated' &&
      !['denied', 'unsupported'].includes(bus.state().env.focusedWindow.status)
    )
      clearWindow(bus, at);
    if (event.type === 'app.activated') await appObservation(bus, event, at, recovering, valid);
    else await emit(event.type, event);
  } else if ((event.type === 'window.focused' || event.type === 'window.title') && typeof event.title === 'string') {
    await emit(event.type === 'window.title' ? 'window.title-changed' : event.type, event);
  } else if (event.type === 'window.focused') {
    clearWindow(bus, at);
  } else if (typeof event.type === 'string' && Object.hasOwn(SYSTEM_EVENT_SPECS, event.type)) {
    if (typeof at !== 'number' || !Number.isFinite(at)) return;
    const spec = SYSTEM_EVENT_SPECS[event.type] as SystemEventSpec;
    const tracker = getSystemTracker(bus);
    const data: Message = { at };
    if (spec.phase === 'start') {
      tracker[spec.slot] = at;
    } else {
      const startAt = tracker[spec.slot];
      tracker[spec.slot] = undefined;
      if (startAt !== undefined && at - startAt >= 0) {
        data.durationMs = at - startAt;
      }
    }
    await bus.accept({
      id: bus.id(),
      kind: spec.kind,
      at,
      source,
      subject: spec.subject,
      data: recovering ? { ...data, preserveSourceStatus: true } : data,
    });
  }
}
