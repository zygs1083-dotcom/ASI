/** Throwaway P0 Host Remote sampling local environment state for the asi-sense spike panel. */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-token-meter'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { statfsSync } from 'node:fs'
import { cpus, freemem, totalmem } from 'node:os'
import type { CpuInfo } from 'node:os'
import type { ActionResult, SpikeAction, SpikeHelperEvent, SpikeSnapshot, SpikeTokens, SpikeUsageBuckets } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Spike Host Remote: local environment sampling and explicit session actions. */
    asiSenseSpike: AsiSenseSpike
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Environment observations injected by the asi-sense spike's explicit actions. */
    environment: { kind: 'environment' }
  }
}

const HELPER_EVENT_LIMIT = 20
const INJECT_TEXT = 'P0 synthetic environment marker: SPIKE_INJECT_731. Do not run tools.'
const FOLLOWUP_TEXT = 'P0 synthetic followup. Reply with exactly SPIKE_INJECT_VISIBLE if you can see SPIKE_INJECT_731 in earlier context, otherwise reply SPIKE_INJECT_MISSING. Do not run tools.'

interface Config {
  readonly helperPath: string
}

/**
 * Serves the asi-sense spike panel. One shared two-second interval samples the
 * Host environment for every watcher; the Client's explicit Agent selection
 * wins over the most recently active Agent tracked from lifecycle events.
 */
export class AsiSenseSpike extends TypertRemoteService {
  static inject = ['tokenMeter', 'sessionProjections', 'llm', 'agents']

  static Config = z.object({
    /** Absolute path of the compiled macOS environment helper; empty disables it. */
    helperPath: z.string().default(''),
  })

  private seq = 0
  private latest: SpikeSnapshot | undefined
  private readonly waiters = new Set<() => void>()
  private cpuBaseline = cpus()
  private selected: Agent | undefined
  private latestActive: Agent | undefined
  private lastAction: SpikeAction | undefined
  private helperSeq = 0
  private helper: ChildProcess | undefined
  private readonly helperEvents: SpikeHelperEvent[] = []
  private readonly modelContextCache = new Map<string, number | undefined>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'asiSenseSpike')
    ctx.on('agent/created', payload => { this.latestActive = payload.agent })
    ctx.on('agent/status', payload => { this.latestActive = payload.agent })
    ctx.on('agent/disposed', payload => {
      if (this.selected === payload.agent) this.selected = undefined
      if (this.latestActive === payload.agent) this.latestActive = undefined
    })
    const timer = setInterval(() => { this.tick() }, 2000)
    ctx.effect(() => () => clearInterval(timer), 'asi-sense-spike: sampler')
    if (config.helperPath !== '') this.startHelper(config.helperPath)
  }

  /**
   * Stream the shared sampler's snapshots; cancellation ends only this subscription.
   * @param signal - subscription lifetime.
   * @returns each sampled snapshot as the shared interval emits it.
   */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<SpikeSnapshot> {
    let delivered = 0
    while (!signal.aborted) {
      const snap = this.latest
      if (snap !== undefined && snap.seq !== delivered) {
        delivered = snap.seq
        yield snap
        continue
      }
      await new Promise<void>(resolve => {
        const onTick = () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          this.waiters.delete(onTick)
          resolve()
        }
        this.waiters.add(onTick)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }

  /**
   * Pin the Agent whose token/context facts the panel reads. Explicit Client
   * selection wins over Host-tracked latest activity until disposal or reselect.
   * @param sessionId - wire identity of the Session whose live Agent to pin.
   * @throws RemoteError `gateway/bad-request` when no live Agent owns the id.
   */
  @Remote('select')
  select(sessionId: string): void {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) {
      const detail = `no live agent for session ${sessionId}`
      this.record('select', { ok: false, detail })
      throw new RemoteError('gateway/bad-request', detail, {})
    }
    this.selected = agent
    this.record('select', { ok: true, detail: agent.id })
  }

  /**
   * Queue the authored synthetic environment marker for the Agent's next step.
   * @param sessionId - wire identity of the target Session's live Agent.
   * @returns the recorded action result; failures report ok=false.
   */
  @Remote('inject')
  inject(sessionId: string): ActionResult {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) {
      return this.record('inject', { ok: false, detail: `no live agent for session ${sessionId}` })
    }
    try {
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: INJECT_TEXT }],
        source: { kind: 'environment' },
      }))
      return this.record('inject', { ok: true })
    } catch (error) {
      return this.record('inject', { ok: false, detail: String(error) })
    }
  }

  /**
   * Queue the authored synthetic follow-up turn on the Agent.
   * @param sessionId - wire identity of the target Session's live Agent.
   * @returns the recorded action result; failures report ok=false.
   */
  @Remote('followup')
  followup(sessionId: string): ActionResult {
    const agent = this.agentFor(sessionId)
    if (agent === undefined) {
      return this.record('followup', { ok: false, detail: `no live agent for session ${sessionId}` })
    }
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: FOLLOWUP_TEXT }],
        source: { kind: 'environment' },
      }))
      return this.record('followup', { ok: true })
    } catch (error) {
      return this.record('followup', { ok: false, detail: String(error) })
    }
  }

  /**
   * Read one fresh snapshot without subscribing to the stream.
   * @returns the current environment sample.
   */
  @Remote('snapshot')
  async snapshot(): Promise<SpikeSnapshot> {
    return this.takeSnapshot()
  }

  /** Resolve a wire session id to its live Agent; absent when unknown or dead. */
  private agentFor(sessionId: string): Agent | undefined {
    if (sessionId === '') return undefined
    return this.ctx.agents.get(sessionId as SessionId)
  }

  private record(kind: string, result: ActionResult): ActionResult {
    this.lastAction = {
      kind,
      ok: result.ok,
      at: Date.now(),
      ...(result.detail !== undefined ? { detail: result.detail } : {}),
    }
    return result
  }

  private tick(): void {
    void this.takeSnapshot().then(snap => {
      this.latest = snap
      for (const waiter of [...this.waiters]) {
        this.waiters.delete(waiter)
        waiter()
      }
    }, error => {
      this.acceptHelper({ type: 'diagnostic', fields: { status: 'sample-failed', detail: String(error) } })
    })
  }

  private async takeSnapshot(): Promise<SpikeSnapshot> {
    const agent = this.selected ?? this.latestActive
    const tokens = agent === undefined ? undefined : await this.readTokens(agent)
    return {
      seq: ++this.seq,
      at: Date.now(),
      hostPid: process.pid,
      ...(this.helper?.pid !== undefined ? { helperPid: this.helper.pid } : {}),
      cpu: this.computeCpu(),
      memUsed: totalmem() - freemem(),
      memTotal: totalmem(),
      diskFree: this.diskFree(),
      ...(agent === undefined ? {} : { agent: { id: agent.id, status: agent.status } }),
      ...(tokens === undefined ? {} : { tokens }),
      helperEvents: [...this.helperEvents],
      ...(this.lastAction === undefined ? {} : { lastAction: this.lastAction }),
    }
  }

  private computeCpu(): number {
    const now = cpus()
    const before = this.cpuBaseline
    this.cpuBaseline = now
    let busy = 0
    let all = 0
    const count = Math.min(before.length, now.length)
    for (let index = 0; index < count; index++) {
      const a = before[index].times
      const b = now[index].times
      const idleDelta = b.idle - a.idle
      const totalDelta = (b.user + b.nice + b.sys + b.irq + b.idle) - (a.user + a.nice + a.sys + a.irq + a.idle)
      if (totalDelta <= 0) continue
      busy += totalDelta - Math.max(0, idleDelta)
      all += totalDelta
    }
    return all === 0 ? 0 : Math.min(1, Math.max(0, busy / all))
  }

  private diskFree(): number {
    try {
      const stat = statfsSync(process.cwd())
      return stat.bavail * stat.bsize
    } catch {
      return 0
    }
  }

  private async readTokens(agent: Agent): Promise<SpikeTokens | undefined> {
    let any = false
    const tokens: {
      pressureTokens?: number
      contextWindow?: number
      projectedTokens?: number
      modelContext?: number
      usage?: SpikeUsageBuckets
    } = {}
    try {
      const pressure = this.ctx.tokenMeter.contextPressure(agent.session)
      if (pressure.pressureTokens !== undefined) { tokens.pressureTokens = pressure.pressureTokens; any = true }
      if (pressure.contextWindow !== undefined) { tokens.contextWindow = pressure.contextWindow; any = true }
    } catch { /* meter unavailable for this session */ }
    try {
      const projected = this.ctx.sessionProjections.snapshot(agent.session, ['tokenUsage', 'contextPressure'])
      const context = projected.values.contextPressure as { projectedTokens?: number } | undefined
      if (context?.projectedTokens !== undefined) { tokens.projectedTokens = context.projectedTokens; any = true }
      const usage = projected.values.tokenUsage as Partial<SpikeUsageBuckets> | undefined
      if (usage !== undefined
        && typeof usage.uncachedInputTokens === 'number'
        && typeof usage.outputTokens === 'number'
        && typeof usage.cacheReadTokens === 'number'
        && typeof usage.cacheWriteTokens === 'number') {
        tokens.usage = {
          uncachedInputTokens: usage.uncachedInputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        }
        any = true
      }
    } catch { /* projection unavailable for this session */ }
    try {
      const current = agent.model.current()
      if (current !== undefined) {
        const key = `${current.provider}/${current.model}`
        let context = this.modelContextCache.get(key)
        if (!this.modelContextCache.has(key)) {
          try {
            context = (await this.ctx.llm.resolveModelInfo(current.provider, current.model)).context?.contextWindow
          } catch { /* route info unavailable */ }
          this.modelContextCache.set(key, context)
        }
        if (context !== undefined) { tokens.modelContext = context; any = true }
      }
    } catch { /* model selection unavailable */ }
    return any ? tokens : undefined
  }

  private startHelper(path: string): void {
    let child: ChildProcess
    try {
      child = spawn(path, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      this.acceptHelper({ type: 'helper', fields: { status: 'spawn-failed', detail: String(error) } })
      return
    }
    this.helper = child
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        this.acceptHelperLine(line)
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr?.resume()
    child.on('error', error => this.acceptHelper({ type: 'helper', fields: { status: 'error', detail: String(error) } }))
    child.on('exit', (code, signal) => {
      this.helper = undefined
      this.acceptHelper({ type: 'helper', fields: { status: 'exited', detail: `code=${String(code)} signal=${String(signal)}` } })
    })
    this.ctx.effect(() => async () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const exited = await Promise.race([
        once(child, 'exit').then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2000).unref()),
      ])
      if (!exited) child.kill('SIGKILL')
    }, 'asi-sense-spike: helper')
  }

  private acceptHelperLine(line: string): void {
    if (line.trim() === '') return
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      this.acceptHelper({ type: 'helper', fields: { status: 'bad-json' } })
      return
    }
    if (typeof value !== 'object' || value === null || typeof (value as Record<string, unknown>).type !== 'string') {
      this.acceptHelper({ type: 'helper', fields: { status: 'bad-shape' } })
      return
    }
    const record = value as Record<string, unknown>
    const fields: Record<string, string | number | boolean> = {}
    for (const [key, item] of Object.entries(record)) {
      if (key === 'type') continue
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') fields[key] = item
    }
    this.acceptHelper({ type: record.type as string, ...(Object.keys(fields).length > 0 ? { fields } : {}) })
  }

  private acceptHelper(event: Omit<SpikeHelperEvent, 'seq' | 'at'>): void {
    this.helperEvents.push({ seq: ++this.helperSeq, at: Date.now(), ...event })
    while (this.helperEvents.length > HELPER_EVENT_LIMIT) this.helperEvents.shift()
  }
}

export default AsiSenseSpike
