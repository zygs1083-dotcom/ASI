import type { Body, SourceRef } from '@asi/sense-types';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { BodySource } from './body.ts';

export const source: SourceRef = { id: 'helper', api: 'ndjson', host: 'local' };
export const ax: SourceRef = { id: 'helper.ax', api: 'accessibility', host: 'local' };
export type Message = Record<string, unknown>;

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
export function clearWindow(attention: RuntimeAttention, at: number): void {
  if (attention.isStopped()) return;
  attention.store.apply({
    id: attention.id(),
    kind: 'fact.updated',
    at,
    source: { ...ax, id: 'helper.window' },
    subject: 'env.focusedWindow',
    data: { path: 'env.focusedWindow', value: null, status: 'unknown' },
  });
  attention.changed();
}
export async function helperStatus(
  attention: RuntimeAttention,
  at: number,
  status: 'ok' | 'unavailable' | 'error',
  reason: string,
  restarts: number,
  lastFailure?: string,
): Promise<void> {
  if (status !== 'ok' && !attention.isStopped()) {
    attention.store.apply({
      id: attention.id(),
      kind: 'fact.updated',
      at,
      source: ax,
      subject: 'self.permissions',
      data: { path: 'self.permissions', value: null, status: 'unknown', reason: '辅助功能状态不可用' },
    });
    attention.changed();
  }
  await attention.accept({
    id: attention.id(),
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
export async function helperError(attention: RuntimeAttention, event: Message): Promise<string> {
  const code = typeof event.code === 'string' ? event.code : 'protocol-error';
  await attention.accept({
    id: attention.id(),
    kind: 'source.error',
    at: event.at as number,
    source,
    subject: source.id,
    data: { error: code, dropped: event.dropped, droppedTypes: event.droppedTypes },
  });
  return code;
}
export function permissionStatus(attention: RuntimeAttention, status: 'granted' | 'denied', at: number): void {
  if (attention.isStopped()) return;
  attention.store.apply({
    id: attention.id(),
    kind: 'fact.updated',
    at,
    source: ax,
    subject: 'self.permissions',
    data: {
      path: 'self.permissions',
      value: { 辅助功能: status, '其他权限（DSH 未提供）': 'unknown' },
      status: 'ok',
      ttlMs: 86_400_000,
    },
  });
  attention.changed();
}
export async function axStatus(
  attention: RuntimeAttention,
  status: 'ok' | 'denied' | 'unsupported',
  at: number,
): Promise<void> {
  if (attention.isStopped()) return;
  const previous = attention.state().env.focusedWindow.status;
  if (status !== 'ok' || previous === 'denied' || previous === 'unsupported') {
    attention.store.apply({
      id: attention.id(),
      kind: 'fact.updated',
      at,
      source: { ...ax, id: 'helper.window' },
      subject: 'env.focusedWindow',
      data: { path: 'env.focusedWindow', value: null, status: status === 'ok' ? 'unknown' : status },
    });
  }
  await attention.accept({
    id: attention.id(),
    kind: 'source.status',
    at,
    source: ax,
    subject: ax.id,
    data: { status },
  });
}
export async function helperEvent(
  event: Message,
  attention: RuntimeAttention,
  body: BodySource,
  recovering = false,
  skip: ReadonlySet<string> = new Set(),
  valid: () => boolean = () => true,
): Promise<void> {
  if (attention.isStopped()) return;
  const at = event.at as number;
  const emit = async (kind: string, data: Message) => {
    await attention.accept({
      id: attention.id(),
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
    if (validApp(app) && !skip.has('frontApp')) await emit('app.activated', app);
    if (!valid()) return;
    const window = object(event.focusedWindow);
    if (!skip.has('focusedWindow')) {
      if (window?.status === 'denied' || window?.status === 'unsupported') await axStatus(attention, window.status, at);
      else if (window?.status === 'ok' && typeof window.title === 'string') await emit('window.focused', window);
      else if (window) clearWindow(attention, at);
    }
    if (!valid()) return;
    if (!skip.has('thermal') && ['nominal', 'fair', 'serious', 'critical'].includes(String(event.thermal))) {
      body.setThermal(
        { value: event.thermal as Body['thermal']['value'], status: 'ok', source, observedAt: at, ttlMs: 60_000 },
        recovering,
      );
    }
  } else if (event.type === 'ax.unsupported') {
    await axStatus(attention, 'unsupported', at);
  } else if (event.type === 'app.activated' || event.type === 'app.launched' || event.type === 'app.terminated') {
    if (event.type === 'app.activated' && !validApp(event)) return;
    if (
      recovering &&
      event.type === 'app.activated' &&
      !['denied', 'unsupported'].includes(attention.state().env.focusedWindow.status)
    )
      clearWindow(attention, at);
    await emit(event.type, event);
  } else if ((event.type === 'window.focused' || event.type === 'window.title') && typeof event.title === 'string') {
    await emit(event.type === 'window.title' ? 'window.title-changed' : event.type, event);
  } else if (event.type === 'window.focused') {
    clearWindow(attention, at);
  }
}
