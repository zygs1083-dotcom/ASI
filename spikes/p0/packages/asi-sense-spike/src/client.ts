/**
 * Browser half of the asi-sense spike: one sidebar entry and a compact
 * diagnostic main panel fed by the Host Remote's shared two-second stream.
 * The panel's explicit Session selection wins over Host-tracked activity.
 */

import { createElement as h } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import remote from '../lib/typert.remote-client.js'
import type { SpikeSnapshot } from './types.ts'

const NS = 'asi-sense-spike'
const PANEL_ID = 'asi-sense-spike' as MainPanelId

type AsiSenseKey = keyof typeof EN

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** asi-sense spike panel copy. */
    'asi-sense-spike': AsiSenseKey
  }
}

const EN = {
  panel: 'ASI sense',
  title: 'ASI sense spike',
  sample: 'Sample',
  cpu: 'CPU',
  memory: 'Memory',
  diskFree: 'Disk free',
  context: 'Context',
  tokens: 'Token usage',
  hostAgent: 'Host-reported agent',
  helper: 'Helper events',
  lastAction: 'Last action',
  streamStatus: 'Stream status',
  actionStatus: 'Action status',
  selectedSession: 'Selected session',
  noSession: 'no session selected',
  select: 'Select in Host',
  inject: 'Inject marker',
  followup: 'Send followup',
  empty: '—',
}

interface Source<T> {
  subscribe(listener: () => void): () => void
  getSnapshot(): T
}

function createSource<T>(initial: T): Source<T> & { set(value: T): void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot() { return value },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

interface SessionListLike {
  ids: readonly string[]
  byId: Record<string, { id: string, retainedBy: Record<string, number | undefined> } | undefined>
}

interface AsiSensePanelProps {
  t: (key: string) => string
  useSessions: <T>(selector: (state: SessionListLike) => T) => T
  useSnapshot: <T>(selector: (state: SpikeSnapshot | undefined) => T) => T
  useStreamStatus: <T>(selector: (state: string) => T) => T
  useActionStatus: <T>(selector: (state: string) => T) => T
  onSelect: (sessionId: string) => void
  onInject: (sessionId: string) => void
  onFollowup: (sessionId: string) => void
}

function bytes(value: number | undefined): string {
  if (value === undefined) return EN.empty
  const gib = value / (1024 * 1024 * 1024)
  return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${(value / (1024 * 1024)).toFixed(0)} MiB`
}

function Row({ label, value, testid }: { label: string, value: string, testid?: string }) {
  return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0', fontSize: 12 } },
    h('span', { style: { opacity: 0.65 } }, label),
    h('span', { style: { fontFamily: 'monospace', textAlign: 'right' }, ...(testid === undefined ? {} : { 'data-testid': testid }) }, value))
}

function AsiSensePanel({ t, useSessions, useSnapshot, useStreamStatus, useActionStatus, onSelect, onInject, onFollowup }: AsiSensePanelProps) {
  const snap = useSnapshot(s => s)
  const streamStatus = useStreamStatus(s => s)
  const actionStatus = useActionStatus(s => s)
  const selectedId = useSessions(state => state.ids.find(id => (state.byId[id]?.retainedBy.mainView ?? 0) > 0))
  const button = (label: string, testid: string, onClick: () => void, disabled: boolean) =>
    h('button', {
      'data-testid': testid,
      disabled,
      onClick,
      style: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid currentColor', opacity: disabled ? 0.4 : 1 },
    }, label)

  const tokens = snap?.tokens
  const usage = tokens?.usage
  const contextValue = tokens === undefined ? EN.empty
    : `${tokens.pressureTokens ?? EN.empty} / ${tokens.contextWindow ?? EN.empty} / ${tokens.projectedTokens ?? EN.empty}`
  const usageValue = usage === undefined ? EN.empty
    : `in ${usage.uncachedInputTokens} out ${usage.outputTokens} cr ${usage.cacheReadTokens} cw ${usage.cacheWriteTokens}`

  return h('div', { 'data-testid': 'asi-sense-panel', style: { padding: 16, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 8 } },
    h('div', { style: { fontSize: 14, fontWeight: 600 } }, t('title')),
    h('div', { 'data-testid': 'asi-sense-selected', style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 } },
      h('span', { style: { opacity: 0.65 } }, t('selectedSession')),
      h('span', { style: { fontFamily: 'monospace' } }, selectedId ?? t('noSession')),
      button(t('select'), 'asi-sense-select', () => { if (selectedId !== undefined) onSelect(selectedId) }, selectedId === undefined)),
    h('div', { style: { display: 'flex', gap: 8 } },
      button(t('inject'), 'asi-sense-inject', () => { if (selectedId !== undefined) onInject(selectedId) }, selectedId === undefined),
      button(t('followup'), 'asi-sense-followup', () => { if (selectedId !== undefined) onFollowup(selectedId) }, selectedId === undefined)),
    h(Row, { label: t('streamStatus'), value: streamStatus === '' ? EN.empty : streamStatus, testid: 'asi-sense-stream-status' }),
    h(Row, { label: t('sample'), value: snap === undefined ? EN.empty : `#${snap.seq} ${new Date(snap.at).toISOString()}`, testid: 'asi-sense-sample' }),
    h(Row, { label: t('cpu'), value: snap === undefined ? EN.empty : `${(snap.cpu * 100).toFixed(1)}%`, testid: 'asi-sense-cpu' }),
    h(Row, { label: t('memory'), value: snap === undefined ? EN.empty : `${bytes(snap.memUsed)} / ${bytes(snap.memTotal)}`, testid: 'asi-sense-memory' }),
    h(Row, { label: t('diskFree'), value: snap === undefined ? EN.empty : bytes(snap.diskFree), testid: 'asi-sense-disk' }),
    h(Row, { label: t('hostAgent'), value: snap?.agent === undefined ? EN.empty : `${snap.agent.id} (${snap.agent.status})`, testid: 'asi-sense-agent' }),
    h(Row, { label: t('context'), value: contextValue, testid: 'asi-sense-context' }),
    h(Row, { label: t('tokens'), value: usageValue, testid: 'asi-sense-tokens' }),
    h('div', { 'data-testid': 'asi-sense-helper', style: { fontSize: 12 } },
      h('div', { style: { opacity: 0.65 } }, t('helper')),
      ...(snap?.helperEvents ?? []).slice(-8).map(event => h('div', { key: event.seq, style: { fontFamily: 'monospace', opacity: 0.85 } },
        `#${event.seq} ${event.type} ${event.fields === undefined ? '' : JSON.stringify(event.fields)}`))),
    h(Row, { label: t('lastAction'), value: snap?.lastAction === undefined ? EN.empty : `${snap.lastAction.kind} ok=${snap.lastAction.ok}${snap.lastAction.detail === undefined ? '' : ` ${snap.lastAction.detail}`}`, testid: 'asi-sense-last-action' }),
    h(Row, { label: t('actionStatus'), value: actionStatus === '' ? EN.empty : actionStatus, testid: 'asi-sense-action-status' }))
}

function AsiSenseIcon({ size }: { size: number }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', 'stroke-width': 1.4 }),
    h('circle', { cx: 8, cy: 8, r: 2, fill: 'currentColor' }))
}

interface RemoteResultLike {
  readonly ok: boolean
  readonly error?: { readonly code: string, readonly message: string }
}

export const inject = ['remote', 'slots', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en: EN } as never), 'asi-sense-spike: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(async function* () {
    const unmountRemote = await ctx.remote.$mount(remote)
    yield () => unmountRemote()
    const remoteFiber = ctx.inject(['remote.asiSenseSpike', 'slots', 'locale'], (remoteCtx) => {
      const api = remoteCtx.remote.asiSenseSpike
      const snapshots = createSource<SpikeSnapshot | undefined>(undefined)
      const streamStatus = createSource('connecting')
      const actionStatus = createSource('')
      const stream = api.watch()
      const pump = (async () => {
        try {
          let first = true
          for await (const snap of stream) {
            if (first) { streamStatus.set('live'); first = false }
            snapshots.set(snap)
          }
          streamStatus.set('ended')
        } catch (error) {
          streamStatus.set(`error: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
      remoteCtx.effect(() => async () => {
        stream.dispose()
        await pump
      }, 'asi-sense-spike: stream')
      const runAction = (kind: string, call: Promise<RemoteResultLike>) => {
        void call.then(result => {
          actionStatus.set(result.ok
            ? `${kind}: delivered`
            : `${kind}: ${result.error?.code ?? 'failed'} ${result.error?.message ?? ''}`.trim())
        }, error => {
          actionStatus.set(`${kind}: transport ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      remoteCtx.effect(() => remoteCtx.slots.inject('main', () => remoteCtx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: (): { hooks: { snapshot: Source<SpikeSnapshot | undefined>, streamStatus: Source<string>, actionStatus: Source<string> }, onSelect: (id: string) => void, onInject: (id: string) => void, onFollowup: (id: string) => void } => ({
          hooks: { snapshot: snapshots, streamStatus, actionStatus },
          onSelect: id => { runAction('select', api.select(id)) },
          onInject: id => { runAction('inject', api.inject(id)) },
          onFollowup: id => { runAction('followup', api.followup(id)) },
        }),
      }, AsiSensePanel as never)), 'asi-sense-spike: main slot')
      remoteCtx.effect(() => remoteCtx.slots.inject('sidebar.panellist', () => remoteCtx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 90,
        locale: NS,
        label: () => t('panel'),
      }, AsiSenseIcon as never)), 'asi-sense-spike: sidebar slot')
    })
    yield async () => { await remoteFiber.dispose() }
  }, 'asi-sense-spike: panel')
}
