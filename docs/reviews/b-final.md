verdict: pass

# b1 / b2 真实 DSH 复测

基线 ASI `a2c7edc`，DSH `39163dd30f703a79079e2d2446545cff3c453738`，
macOS arm64，Node 26.13.0。模型只使用本机 magpie；两项各运行一次，共
**7/8 次请求**。不保存真实屏幕或消息内容。

## b1 自因失败

`DSH_ROOT=/Users/wangying/orca/dsh ASI_E2E_MODEL_BUDGET=3 ASI_E2E_ONLY_SELF=1 ASI_E2E_TEST_TOOL=1 pnpm --filter asi-sense exec tsx scripts/e2e-dsh.ts`
退出 0，模型请求 **3/3**。真实 agent 执行 `false` 并调用 `env_state`：
环境 followup 0、next-step 注入 0、环境消息 0；事件 DOM 的
`data-level="suppressed"`，且包含「已抑制」和「Agent 自己引起」。
`self-caused` 的 reason 和 cause 不变。对应 presenter 回归测试先失败后通过；
无需修改 sense-ui 夹具或截图。

## b2 后台失败

`DSH_ROOT=/Users/wangying/orca/dsh ASI_E2E_MODEL_BUDGET=5 ASI_E2E_ONLY_BACKGROUND=1 pnpm --filter asi-sense exec tsx scripts/e2e-dsh.ts`
退出 0，模型请求 **4/5**。脚本核对了后台 bash 参数及侧栏 `job-failed`
事件；初始轮完成后，观察到任务结束、新增 agent 轮次 **1**，该轮环境消息
**1**、结束原因 `completed`、非空回复长度 3。等待 4 秒后轮次和消息仍各为 1。
不要求 ASI 自己的 `next-turn` 插入；该次实际序列为：

```text
job/settled
agent/inbox/spliced(next-turn:tool-jobs)
turn/start
agent/inbox/spliced
step/start
user/message(tool-jobs)
agent/inbox/spliced(next-step:environment)
assistant/message
step/end
agent/inbox/spliced
step/start
user/message(environment)
assistant/message
step/end
turn/end
```

因此这次是 `tool-jobs` 的 next-turn 通知先开轮，ASI 环境消息进入同一轮的
后续 step；不应将它误判为没有唤醒。回复只验证非空和结束状态，不评价其语义。

实机运行后增加了对 `job/settled` 的 bash 标签、`exit code: 1` 和先于新轮次的
显式断言，相关成功、错误退出和顺序反例均通过零模型请求单测。实际运行的
脱敏序列证明 `job/settled` 先于 `turn/start`，侧栏证明该任务失败；由于遵守
每项仅运行一次的限制，新增的 settlement 载荷断言未再次实机执行，且该次载荷
具体字段未单独留存。

## 其他检查与清理

- `pnpm install --frozen-lockfile && pnpm check`：退出 0；typecheck、Biome
  通过，body-probe **215**、sense-ui **297**、asi-sense **652** 测试通过。
- `pnpm --filter asi-sense run build`：退出 0，含 macOS Swift helper 构建。
- b1 DSH/helper PID 31523/31568，b2 PID 32065/32092；脚本关闭浏览器和进程组，
  两次临时 profile 均确认删除，复查本任务进程组及 helper 数为 0。用户 DSH
  PID 5459 仍在运行，未操作。
- 本次未重测文件监视、其他 e2e 场景或模型回复语义；这些不在本任务范围。
