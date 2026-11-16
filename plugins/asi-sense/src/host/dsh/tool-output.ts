import os from 'node:os';
import path from 'node:path';
import type { Fact, SenseState, WatchRule } from '@asi/sense-types';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { createSenseRuntime } from '../runtime/index.ts';
import type { JsonValue } from './wire-types.ts';

const MAX_BYTES = 32_768;

export function modelText(value: string, hostname = os.hostname()): string {
  const safe = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[endpoint]')
    .replace(/(?<![\w])(?:[A-Za-z]:\\|\/)(?:[^\s"'<>/\\]+[/\\])*[^\s"'<>/\\]*/g, (path) => {
      const parts = path.split(/[\\/]/).filter(Boolean);
      return parts.at(-1) ?? '[path]';
    });
  return hostname ? safe.replace(new RegExp(hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[host]') : safe;
}

export function modelTitle(value: string, hostname = os.hostname()): string {
  const hidden: string[] = [];
  const hide = () => `\0${hidden.push('<host>') - 1}\0`;
  const escapedHost = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const projected = value
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi, hide)
    .replace(/(?<![\w])(?:[A-Za-z]:\\|\/|[\p{L}\p{N}._-]+\/)(?:[^\s"'<>/\\]+[/\\])*[^\s"'<>/\\]*/gu, (path) => {
      const parts = path.split(/[\\/]/).filter(Boolean);
      return parts.at(-1) ?? '[path]';
    })
    .replace(/\b[\w.+%-]+@(?:\[[\da-f:.]+\]|[\w.-]+)(?::\d+)?/gi, hide)
    .replace(/\[[\da-f:.]+\](?::\d+)?|(?<![\w:])(?:[\da-f]{0,4}:){2,}[\da-f]{0,4}(?![\w:])/gi, hide)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/gi, hide)
    .replace(/\b[a-z\d_-]+(?:\.[a-z\d_-]+)*:\d+\b/gi, hide);
  const withoutLocalHost = hostname ? projected.replace(new RegExp(escapedHost, 'gi'), hide) : projected;
  return withoutLocalHost.replace(/\0(\d+)\0/g, (_match, index: string) => hidden[Number(index)] ?? '<host>');
}

function minimize(value: JsonValue, hostname: string, title = false): JsonValue {
  if (title && typeof value === 'string') return modelTitle(value, hostname);
  if (typeof value === 'string') return modelText(value, hostname);
  if (Array.isArray(value)) return value.map((item) => minimize(item, hostname));
  if (value === null || typeof value !== 'object') return value;
  const entries: Record<string, JsonValue> = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'host' || key === 'endpoint' || key === 'command' || key === 'userSession') continue;
    const base = modelText(key, hostname);
    let name = base;
    for (let n = 2; Object.hasOwn(entries, name); n++) name = `${base} (${n})`;
    entries[name] = minimize(child, hostname, key === 'title');
  }
  return entries;
}

export function modelPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return modelText(path.posix.basename(normalized) || '[path]');
}

export function modelLabel(value: string): string {
  return /^[\p{L}\p{N}_ -]+$/u.test(value) ? modelText(value) : '[redacted]';
}

function identifier(value: string): string {
  return /^[\w-]+$/.test(value) ? modelText(value) : '[redacted]';
}

function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, Reflect.get(value, key)]),
  );
}

function fact<T>(input: Fact<T>, project: (value: T) => unknown): object {
  return {
    value: input.value === null ? null : project(input.value),
    status: input.status,
    source: { id: identifier(input.source.id), api: identifier(input.source.api) },
    observedAt: input.observedAt,
    ttlMs: input.ttlMs,
  };
}

function dictionary<T>(values: Record<string, T>, key: (value: string) => string, project: (value: T) => unknown) {
  const entries: Record<string, unknown> = Object.create(null);
  for (const [original, value] of Object.entries(values)) {
    const base = key(original);
    let name = base;
    for (let n = 2; Object.hasOwn(entries, name); n++) name = `${base} (${n})`;
    entries[name] = project(value);
  }
  return entries;
}

function observations(state: SenseState['observation']) {
  return {
    sources: dictionary(state.sources, identifier, (source) => pick(source, ['status', 'lastSignalAt'])),
  };
}

export function modelState(state: SenseState, now: number, section?: 'self' | 'env' | 'observation'): JsonValue {
  const { self, env } = state;
  const body = self.body;
  const projected = {
    self: {
      activity: fact(self.activity, (value) => value),
      pending: fact(self.pending, (value) => pick(value, ['inbox', 'jobs'])),
      tools: fact(self.tools, (value) => value.map(identifier)),
      permissions: fact(self.permissions, (value) => dictionary(value, identifier, (status) => status)),
      body: {
        cpu: fact(body.cpu, (value) => pick(value, ['usage', 'perCore', 'load1', 'load5', 'load15'])),
        memory: fact(body.memory, (value) => pick(value, ['total', 'used', 'pressure', 'swapUsed'])),
        disks: fact(body.disks, (value) =>
          value.map((disk) => ({
            ...pick(disk, ['total', 'free', 'status', 'observedAt', 'ttlMs']),
            mount: modelPath(disk.mount),
          })),
        ),
        battery: fact(body.battery, (value) =>
          value === null ? null : pick(value, ['percent', 'charging', 'minutesLeft', 'powerState', 'estimatePending']),
        ),
        thermal: fact(body.thermal, (value) => value),
        network: fact(body.network, (value) => pick(value, ['online', 'rxBps', 'txBps'])),
        harnessProcess: fact(body.harnessProcess, (value) => pick(value, ['rss', 'cpu', 'uptimeSec'])),
        tokens: fact(body.tokens, (value) => ({
          ...pick(value, ['contextWindow', 'contextUsed', 'contextProjected', 'contextWindowSource']),
          sessionUsage: pick(value.sessionUsage, ['input', 'output', 'cacheRead', 'cacheWrite']),
          ...(value.balance
            ? { balance: { amount: value.balance.amount, currency: identifier(value.balance.currency) } }
            : {}),
        })),
      },
    },
    env: {
      where: {
        model: fact(env.where.model, (value) => ({ provider: identifier(value.provider), local: value.local })),
        harness: fact(env.where.harness, (value) => ({ os: modelLabel(value.os) })),
        observed: fact(env.where.observed, () => ({})),
        toolExec: fact(env.where.toolExec, (value) => ({ cwd: modelPath(value.cwd) })),
      },
      frontApp: fact(env.frontApp, (value) => ({ name: modelLabel(value.name) })),
      focusedWindow: fact(env.focusedWindow, (value) => ({ title: value.title })),
      activeJobs: fact(env.activeJobs, (value) =>
        value.map((job) => ({ ...pick(job, ['startedAt', 'status', 'exitCode']), id: identifier(job.id) })),
      ),
      watchedPaths: fact(env.watchedPaths, (value) =>
        dictionary(value, modelPath, (item) => pick(item, ['lastChange', 'changes'])),
      ),
    },
    observation: observations(state.observation),
  };
  return modelOutput(section ? projected[section] : projected, now);
}

export function modelRules(rules: WatchRule[]): JsonValue {
  const kinds = new Set([
    'app.activated',
    'app.launched',
    'app.terminated',
    'window.focused',
    'window.title-changed',
    'file.changed',
    'job.started',
    'job.exited',
    'process.exited',
    'source.status',
    'source.error',
    'body.threshold',
    'body.rate',
    'body.anomaly',
    'file.burst',
    'fact.updated',
  ]);
  return modelOutput(
    rules.map((rule) => {
      const where: Record<string, unknown> = {};
      const exitCode = rule.match.where?.exitCode;
      if (typeof exitCode === 'number') where.exitCode = exitCode;
      else if (exitCode && typeof exitCode === 'object' && !Array.isArray(exitCode)) {
        where.exitCode = Object.fromEntries(
          Object.entries(exitCode).filter(
            ([operator, value]) =>
              ['==', '!=', '>', '>=', '<', '<='].includes(operator) &&
              typeof value === 'number' &&
              Number.isFinite(value),
          ),
        );
      }
      const severity = rule.match.where?.severity;
      if (typeof severity === 'string' && ['normal', 'warn', 'critical'].includes(severity)) where.severity = severity;
      const status = rule.match.where?.status;
      if (typeof status === 'string' && ['ok', 'denied', 'error', 'unavailable', 'unknown'].includes(status))
        where.status = status;
      return {
        ...pick(rule, ['level', 'createdBy', 'approved', 'expiresAt']),
        id: identifier(rule.id),
        match: {
          kind: kinds.has(rule.match.kind) ? rule.match.kind : '[redacted]',
          ...(rule.match.kind === 'file.changed' && rule.match.subject !== undefined
            ? { subject: modelPath(rule.match.subject) }
            : {}),
          ...(Object.keys(where).length ? { where } : {}),
        },
      };
    }),
  );
}

export function modelTune(value: unknown): JsonValue {
  if (!value || typeof value !== 'object') return modelOutput({});
  const result = pick(value, ['applied']);
  const change = Reflect.get(value, 'change');
  if (change && typeof change === 'object') {
    const fields = pick(change, ['at', 'by', 'operation', 'status']);
    const id = Reflect.get(change, 'id');
    if (typeof id === 'string') fields.id = identifier(id);
    const param = Reflect.get(change, 'param');
    const params = [
      'rate.disk.maxDelta',
      'rate.rss.maxRatio',
      'rate.context.maxEtaMs',
      'anomaly.cpu.sigma',
      'anomaly.memory.sigma',
      'anomaly.network.sigma',
      'file.burst.windowMs',
      'file.burst.maxChanges',
      'file.burst.maxDeleted',
      'mergeWindowMs',
      'fileMergeWindowMs',
      'deliveryLevel.body.rate',
      'deliveryLevel.body.anomaly',
      'deliveryLevel.file.burst',
      ...['disk', 'context', 'battery'].flatMap((metric) =>
        ['warn', 'critical'].map((severity) => `floor.${metric}.${severity}`),
      ),
    ];
    if (typeof param === 'string') fields.param = params.includes(param) ? param : '[redacted]';
    const reason = Reflect.get(change, 'rejectionReason');
    const reasons = [
      'nonfinite clock',
      'unknown param',
      'type mismatch',
      'nonfinite',
      'no-op',
      'not in choices',
      'out of bounds',
      'untrusted actor',
      'param locked',
      'restore pending',
      'tuning disabled: restore-failed',
      'tuning disabled: storage-failed',
      'exceeds ±50%',
      'safety: cannot loosen',
      'frozen: wall clock behind saved highwater',
      'hourly change limit',
      'daily change limit',
      'global daily change limit',
      'unknown or consumed alert',
    ];
    if (typeof reason === 'string' && reasons.includes(reason)) {
      fields.rejectionReason = reason;
      result.reason = reason;
    }
    for (const key of ['from', 'to']) {
      const item = Reflect.get(change, key);
      if (
        typeof item === 'number' ||
        typeof item === 'boolean' ||
        (typeof item === 'string' && ['record', 'context', 'wake'].includes(item))
      )
        fields[key] = item;
    }
    result.change = fields;
  }
  return modelOutput(result);
}

function json(value: unknown): JsonValue {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (
      (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) ||
      typeof item === 'function' ||
      typeof item === 'symbol' ||
      typeof item === 'bigint'
    ) {
      throw new TypeError('tool result contains non-JSON data');
    }
    return item;
  });
  if (text === undefined) throw new TypeError('tool result contains no JSON value');
  const parsed: unknown = JSON.parse(text);
  if (!isRemoteJsonValue(parsed)) throw new TypeError('tool result is not lossless JSON');
  return parsed as JsonValue;
}

function ages(value: JsonValue, now: number): JsonValue {
  if (Array.isArray(value)) return value.map((item) => ages(item, now));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ages(child, now)]));
  if (
    typeof entries.observedAt === 'number' &&
    typeof entries.ttlMs === 'number' &&
    typeof entries.status === 'string' &&
    Object.hasOwn(entries, 'value') &&
    Object.hasOwn(entries, 'source')
  ) {
    entries.ageMs = Math.max(0, now - entries.observedAt);
  }
  return entries;
}

export function modelOutput(value: unknown, now?: number): JsonValue {
  const normalized = minimize(json(value), os.hostname());
  const result = now === undefined ? normalized : ages(normalized, now);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_BYTES) return result;
  return {
    truncated: true,
    message: 'Result exceeds the size limit. Request a smaller section or inspect the current foreground application.',
  };
}

type Runtime = Pick<ReturnType<typeof createSenseRuntime>, 'tools' | 'events' | 'rules'>;

export function environmentDetail(
  runtime: Runtime,
  app?: string,
  window?: string,
  sessionId?: string,
  countFresh = true,
): JsonValue {
  const snapshot = runtime.tools.envState(undefined, sessionId);
  if (!('env' in snapshot) || !('observation' in snapshot)) throw new TypeError('full sense state unavailable');
  const { env, observation } = snapshot;
  const front = env.frontApp.value;
  const axStatus = observation.sources['helper.ax']?.status;
  const countDenied = axStatus === 'denied' || axStatus === 'unsupported';
  const title = env.focusedWindow.value?.title;
  const matchesApp = front === null ? null : app === undefined || app === front.name || app === front.bundleId;
  const matchesWindow = window === undefined ? true : title === undefined ? null : modelTitle(title) === window;
  const available = matchesApp === true && matchesWindow === true;
  const mismatch = matchesApp === false || matchesWindow === false;
  const pid =
    available && front?.pid !== undefined
      ? { value: front.pid, status: env.frontApp.status }
      : { value: null, status: 'unknown' };
  const windowCount =
    available && countDenied
      ? { value: null, status: axStatus }
      : available && countFresh && front?.windowCount !== undefined
        ? { value: front.windowCount, status: env.frontApp.status }
        : { value: null, status: 'unknown' };
  const events = available
    ? runtime
        .events()
        .filter((event) =>
          ['app.activated', 'app.launched', 'app.terminated', 'window.focused', 'window.title-changed'].includes(
            event.kind,
          ),
        )
        .slice(-20)
        .map(({ kind, at, level }) => ({ kind, at, level }))
    : [];
  return modelOutput({
    current: available,
    match: mismatch ? 'not-current' : available ? 'current' : 'unknown',
    app: mismatch
      ? null
      : fact(env.frontApp, (value) => ({
          name: modelLabel(value.name),
          ...pick(value, ['pid', ...(countFresh && !countDenied ? ['windowCount'] : [])]),
        })),
    window: mismatch ? null : fact(env.focusedWindow, (value) => ({ title: value.title })),
    pid,
    windowCount,
    recentEvents: events,
    sources: observations(observation).sources,
    guidance: '如需查看窗口内容，请使用当前会话可用的 computer-use 工具（需经其授权流程）',
  });
}
