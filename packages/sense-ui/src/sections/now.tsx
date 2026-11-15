import { effectiveStatus } from '../health'
import { formatAge } from '../format'
import { FactMeta, FactValue, STATUS_TEXT } from '../fact'
import type { Fact, SensePanelProps } from '../view-model'
import css from './now.module.css'

type Panel = Pick<SensePanelProps, 'model' | 'onOpenPermissionSettings'>

const ACTIVITY_TEXT = {
  idle: '空闲',
  thinking: '思考中',
  tool: '执行工具',
  'waiting-user': '等待用户',
} as const

function Item({
  label,
  fact,
  now,
  onOpenPermissionSettings,
  children,
}: {
  label: string
  fact: Fact<unknown>
  now: number
  onOpenPermissionSettings: () => void
  children: React.ReactNode
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
  )
}

export function NowSection({ model, onOpenPermissionSettings }: Panel) {
  const { self, env, observation } = model.state
  const { now, sendTitles } = model
  const ops = onOpenPermissionSettings

  return (
    <>
      <div className={css.group}>位置</div>
      <Item label="模型" fact={env.where.model} now={now} onOpenPermissionSettings={ops}>
        {env.where.model.value && (
          <>
            {env.where.model.value.provider} · {env.where.model.value.endpoint}
            {env.where.model.value.local ? '（本地）' : ''}
          </>
        )}
      </Item>
      <Item label="Harness" fact={env.where.harness} now={now} onOpenPermissionSettings={ops}>
        {env.where.harness.value &&
          `${env.where.harness.value.host} · ${env.where.harness.value.os} · pid ${env.where.harness.value.pid}`}
      </Item>
      <Item label="被观察的电脑" fact={env.where.observed} now={now} onOpenPermissionSettings={ops}>
        {env.where.observed.value &&
          `${env.where.observed.value.host} · ${env.where.observed.value.userSession}`}
      </Item>
      <Item label="工具执行处" fact={env.where.toolExec} now={now} onOpenPermissionSettings={ops}>
        {env.where.toolExec.value &&
          `${env.where.toolExec.value.host} · ${env.where.toolExec.value.cwd}`}
      </Item>

      <div className={css.group}>正在发生</div>
      <Item label="前台应用" fact={env.frontApp} now={now} onOpenPermissionSettings={ops}>
        {env.frontApp.value && `${env.frontApp.value.name}（${env.frontApp.value.bundleId}）`}
      </Item>
      <div className={css.item}>
        <span className={css.itemLabel}>窗口标题</span>
        <span className={css.itemValue}>
          {sendTitles ? (
            <FactValue fact={env.focusedWindow} now={now} onOpenPermissionSettings={ops}>
              {(v) => v.title}
            </FactValue>
          ) : (
            <span className={css.hidden}>已隐藏</span>
          )}
        </span>
        <FactMeta fact={env.focusedWindow} now={now} />
      </div>
      <Item label="自身状态" fact={self.activity} now={now} onOpenPermissionSettings={ops}>
        {self.activity.value && ACTIVITY_TEXT[self.activity.value]}
      </Item>
      <Item label="待处理" fact={self.pending} now={now} onOpenPermissionSettings={ops}>
        {self.pending.value &&
          `收件箱 ${self.pending.value.inbox} · 任务 ${self.pending.value.jobs}`}
      </Item>
      <Item label="活动任务" fact={env.activeJobs} now={now} onOpenPermissionSettings={ops}>
        {env.activeJobs.value &&
          (env.activeJobs.value.length === 0
            ? '无'
            : env.activeJobs.value.map((j) => `${j.name}（${j.status}）`).join('、'))}
      </Item>
      <Item label="关注路径" fact={env.watchedPaths} now={now} onOpenPermissionSettings={ops}>
        {env.watchedPaths.value &&
          (Object.keys(env.watchedPaths.value).length === 0
            ? '无'
            : Object.entries(env.watchedPaths.value)
                .map(
                  ([p, w]) => `${p} · ${w.changes} 次 · ${formatAge(now, w.lastChange)}`,
                )
                .join('；'))}
      </Item>

      <div className={css.group}>权限与信号源</div>
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
      {Object.entries(observation.sources).map(([id, s]) => (
        <div className={css.item} key={id}>
          <span className={css.itemLabel}>{id}</span>
          <span className={css.itemValue}>
            {STATUS_TEXT[s.status] || '正常'}
            {s.error ? `（${s.error}）` : ''}
          </span>
          <span className={css.factMeta}>{formatAge(now, s.lastSignalAt)}</span>
        </div>
      ))}
    </>
  )
}
