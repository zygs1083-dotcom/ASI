import { useClock } from '../clock';
import { FactMeta, FactValue, STATUS_TEXT } from '../fact';
import { formatAge } from '../format';
import { effectiveStatus, isUsable } from '../health';
import { AppIcon } from '../icons';
import type { Fact, SensePanelProps } from '../view-model';
import css from './now.module.css';

type Panel = Pick<SensePanelProps, 'model' | 'onOpenPermissionSettings'>;
type Where = SensePanelProps['model']['state']['env']['where'];

function FocusAppMeta({ fact, now }: { fact: Fact<unknown>; now: number }) {
  const current = useClock(now);
  const shown = effectiveStatus(fact, current) === 'stale' || formatAge(current, fact.observedAt) !== '刚刚';
  return shown ? (
    <>
      {' '}
      · <FactMeta fact={fact} now={now} />
    </>
  ) : null;
}

const ACTIVITY_TEXT = {
  idle: '空闲',
  thinking: '思考中',
  tool: '执行工具',
  'waiting-user': '等待用户',
} as const;

/** 远端 endpoint 的主机名；解析失败时返回原串（不编造）。 */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname || endpoint;
  } catch {
    return endpoint;
  }
}

/** 模型所在主机：local=true 用信号源主机；远端用 endpoint 主机（loopback 不代表物理主机）。 */
function modelHost(w: Where): string | null {
  const v = w.model.value;
  if (!v) return null;
  return v.local ? w.model.source.host : endpointHost(v.endpoint);
}

interface LocNode {
  key: string;
  label: string;
  fact: Fact<unknown>;
  host: string | null;
  /** 完整原始字段（endpoint/provider/os/pid/session/cwd），只在明细里出现。 */
  detail: () => string | null;
}

/** 位置四节点的完整明细：FactValue 状态语义 + FactMeta + 显式来源，合并/不合并都可用。 */
function LocationDetails({
  nodes,
  now,
  onOpenPermissionSettings,
}: {
  nodes: LocNode[];
  now: number;
  onOpenPermissionSettings: () => void;
}) {
  return (
    <div className={css.locDetail}>
      {nodes.map((n) => (
        <div key={n.key} className={css.locRow} data-node={n.key}>
          <span className={css.locRowLabel}>{n.label}</span>
          <span className={css.locRowBody}>
            <FactValue fact={n.fact} now={now} onOpenPermissionSettings={onOpenPermissionSettings}>
              {() => n.detail() ?? '未提供'}
            </FactValue>
            <FactMeta fact={n.fact} now={now} />
            <span className={css.locSrc}>
              来源 {n.fact.source.api}@{n.fact.source.host}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** 位置链：全部可用且同主机时合并为「全部在 x」，否则横向链 + 「位置详情」展开原始字段。 */
function Location({
  where,
  now,
  onOpenPermissionSettings,
}: {
  where: Where;
  now: number;
  onOpenPermissionSettings: () => void;
}) {
  const nodes: LocNode[] = [
    {
      key: 'model',
      label: '模型',
      fact: where.model as Fact<unknown>,
      host: modelHost(where),
      detail: () => {
        const v = where.model.value;
        return v ? `${v.provider} · ${v.endpoint}（${v.local ? '本地' : '远端'}）` : null;
      },
    },
    {
      key: 'harness',
      label: 'Harness',
      fact: where.harness as Fact<unknown>,
      host: where.harness.value?.host ?? null,
      detail: () => {
        const v = where.harness.value;
        return v ? `${v.host} · ${v.os} · pid ${v.pid}` : null;
      },
    },
    {
      key: 'observed',
      label: '被观察电脑',
      fact: where.observed as Fact<unknown>,
      host: where.observed.value?.host ?? null,
      detail: () => {
        const v = where.observed.value;
        return v ? `${v.host} · 会话 ${v.userSession}` : null;
      },
    },
    {
      key: 'toolExec',
      label: '工具执行处',
      fact: where.toolExec as Fact<unknown>,
      host: where.toolExec.value?.host ?? null,
      detail: () => {
        const v = where.toolExec.value;
        return v ? `${v.host} · 工作目录 ${v.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? v.cwd}` : null;
      },
    },
  ];
  const allUsable = nodes.every((n) => isUsable(n.fact, now) && n.host);
  const merged = allUsable && new Set(nodes.map((n) => n.host)).size === 1;
  const base = nodes.find((n) => n.key === 'harness')?.host ?? nodes[0]?.host;

  if (merged) {
    return (
      <details className={css.locMerged}>
        <summary>全部在 {nodes[0]!.host}</summary>
        <LocationDetails nodes={nodes} now={now} onOpenPermissionSettings={onOpenPermissionSettings} />
      </details>
    );
  }

  return (
    <>
      <section className={css.locChain} aria-label="位置链">
        {nodes.map((n, i) => (
          <span key={n.key} className={css.locPart}>
            {i > 0 && (
              <span className={css.locArrow} aria-hidden="true">
                →
              </span>
            )}
            <span className={css.locNode} data-diff={(n.host != null && n.host !== base) || undefined}>
              <span className={css.locLabel}>{n.label}</span>
              <span className={css.locHost}>
                <FactValue fact={n.fact} now={now} onOpenPermissionSettings={onOpenPermissionSettings}>
                  {() => n.host ?? '未知'}
                </FactValue>
                {n.host != null && n.host !== base && <em className={css.locDiffBadge}>异地</em>}
              </span>
            </span>
          </span>
        ))}
      </section>
      <details className={css.locMerged}>
        <summary>位置详情</summary>
        <LocationDetails nodes={nodes} now={now} onOpenPermissionSettings={onOpenPermissionSettings} />
      </details>
    </>
  );
}

function Item({
  label,
  fact,
  now,
  onOpenPermissionSettings,
  children,
}: {
  label: string;
  fact: Fact<unknown>;
  now: number;
  onOpenPermissionSettings: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={css.item}>
      <span className={css.itemLabel}>{label}</span>
      <span className={css.itemValue}>
        <FactValue fact={fact} now={now} onOpenPermissionSettings={onOpenPermissionSettings}>
          {() => children}
        </FactValue>
      </span>
      <FactMeta fact={fact} now={now} />
    </div>
  );
}

export function NowSection({ model, onOpenPermissionSettings }: Panel) {
  const { self, env, observation } = model.state;
  const { now, sendTitles } = model;
  const ops = onOpenPermissionSettings;

  return (
    <>
      <Location where={env.where} now={now} onOpenPermissionSettings={ops} />

      <div className={css.focusCard}>
        <AppIcon />
        <span className={css.focusText}>
          <span className={css.focusApp}>
            <FactValue fact={env.frontApp} now={now} onOpenPermissionSettings={ops}>
              {(v) => <strong className={css.focusName}>{v.name}</strong>}
            </FactValue>
            {isUsable(env.frontApp, now) && <FocusAppMeta fact={env.frontApp} now={now} />}
          </span>
          <span className={css.focusTitle}>
            {sendTitles ? (
              <>
                <FactValue fact={env.focusedWindow} now={now} onOpenPermissionSettings={ops}>
                  {(w) => w.title}
                </FactValue>
                {isUsable(env.focusedWindow, now) && <FactMeta fact={env.focusedWindow} now={now} />}
              </>
            ) : (
              // 标题关闭时整条事实（含 reason/来源/授权动作）都不进 DOM
              <span className={css.hidden}>标题已隐藏</span>
            )}
          </span>
        </span>
      </div>

      <Item label="自身状态" fact={self.activity} now={now} onOpenPermissionSettings={ops}>
        {self.activity.value && ACTIVITY_TEXT[self.activity.value]}
      </Item>
      <Item label="待处理" fact={self.pending} now={now} onOpenPermissionSettings={ops}>
        {self.pending.value && `收件箱 ${self.pending.value.inbox} · 任务 ${self.pending.value.jobs}`}
      </Item>
      <Item label="可用工具" fact={self.tools} now={now} onOpenPermissionSettings={ops}>
        {self.tools.value && (self.tools.value.length ? self.tools.value.join('、') : '无')}
      </Item>
      <Item label="活动任务" fact={env.activeJobs} now={now} onOpenPermissionSettings={ops}>
        {env.activeJobs.value &&
          (env.activeJobs.value.length === 0
            ? '无'
            : env.activeJobs.value.map((j) => `${j.name}（${j.status}${j.owner ? '' : ' · 无主'}）`).join('、'))}
      </Item>
      <Item label="关注路径" fact={env.watchedPaths} now={now} onOpenPermissionSettings={ops}>
        {env.watchedPaths.value &&
          (Object.keys(env.watchedPaths.value).length === 0
            ? '未配置关注路径'
            : Object.entries(env.watchedPaths.value)
                .filter(([p]) =>
                  model.rules.some(
                    (rule) => rule.enabled && rule.match.kind === 'file.changed' && rule.match.subject === p,
                  ),
                )
                .map(([p, w]) => {
                  if (w.changes === 0) return `${p} · 尚无变更`;
                  const age = formatAge(now, w.lastChange);
                  return `${p} · ${w.changes} 次${age === '刚刚' ? '' : ` · ${age}`}`;
                })
                .join('；'))}
      </Item>

      <Item label="权限" fact={self.permissions} now={now} onOpenPermissionSettings={ops}>
        {self.permissions.value &&
          Object.entries(self.permissions.value).map(([name, st]) => (
            <span key={name} className={css.perm}>
              {name}：{st === 'granted' ? '已授权' : st === 'denied' ? '未授权' : '未知'}
              {st === 'denied' && (
                <button type="button" className={css.linkButton} onClick={ops}>
                  授权
                </button>
              )}
            </span>
          ))}
      </Item>

      <details className={css.srcDetails}>
        <summary>信号源 {Object.keys(observation.sources).length} 个</summary>
        {Object.entries(observation.sources).map(([id, s]) => (
          <div className={css.item} key={id}>
            <span className={css.itemLabel}>{id}</span>
            <span className={css.itemValue}>
              {STATUS_TEXT[s.status] || '正常'}
              {s.error ? `（${s.error}）` : ''}
            </span>
            <span className={css.factMeta}>
              {formatAge(now, s.lastSignalAt) === '刚刚' ? '' : formatAge(now, s.lastSignalAt)}
            </span>
          </div>
        ))}
      </details>
    </>
  );
}
