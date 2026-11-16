verdict: fix

# 真实 DSH 复测

基线 ASI `7ae57de`，DSH `39163dd30f703a79079e2d2446545cff3c453738`，
macOS arm64、Node 26.13.0。命令中 `$DSH_ROOT` 指固定版本的 DSH 源码检出。
没有修改业务代码，没有截取真实屏幕；侧栏断言使用 DOM。

## 发现

- **should-fix** `plugins/asi-sense/src/host/attention/pipeline.ts:198-204`、
  `plugins/asi-sense/src/host/presenter/project.ts:143`、
  `packages/sense-ui/src/sections/events.tsx:29-33,130-145`：自因失败确实不投递，
  但 presenter 只将 `wake-budget`、`no-session` 映射为 `suppressed`，
  `self-caused` 仍映射为 `record`。实机事件 DOM 为
  `data-level="record"`，显示“记录”及“Agent 自己引起”；预期为自因“已抑制”。
  复现见第 1 条第二次命令，退出 1。

## 1. b1 自因失败 — 失败（投递通过，DOM 等级失败）

- 第一次：
  `DSH_ROOT=$DSH_ROOT ASI_E2E_MODEL_BUDGET=6 ASI_E2E_ONLY_SELF=1 ASI_E2E_TEST_TOOL=1 pnpm --filter asi-sense exec tsx scripts/e2e-dsh.ts`。
  退出 1，请求 2；模型执行 `false`，0 followup、0 next-step、0 环境消息；
  “自因且已抑制”的 DOM 断言未找到匹配项。此时脚本尚未进入工具补测。
- 第二次：
  `DSH_ROOT=$DSH_ROOT ASI_E2E_MODEL_BUDGET=4 ASI_E2E_ONLY_SELF=1 ASI_E2E_TEST_TOOL=1 pnpm --filter asi-sense exec tsx scripts/e2e-dsh.ts`。
  退出 1，请求 3；0 followup、0 next-step、0 环境消息，DOM 找到 `false`、
  `self-caused` 和“Agent 自己引起”，但等级实际为 `record`，不是 `suppressed`。

两次使用同一脚本的连续修订：第二次将真实 `env_state` 调用合入同一提示，
并先检查自因事件实际等级，再断言预期等级。

## 2. b2 后台失败唤醒 — 失败 / 回复未验证

- 首次：
  `DSH_ROOT=$DSH_ROOT ASI_E2E_MODEL_BUDGET=5 ASI_E2E_ONLY_BACKGROUND=1 pnpm --filter asi-sense exec tsx scripts/e2e-dsh.ts`。
  退出 1，请求 4；当时错误摘要不足以区分等待唤醒还是等待回复。
- 补齐无模型请求的诊断及单测后，按协调端要求只重跑一次：
  `DSH_ROOT=$DSH_ROOT ASI_E2E_ONLY_BACKGROUND=1 ASI_E2E_MODEL_BUDGET=6 pnpm --filter asi-sense exec tsx scripts/e2e-dsh.ts`。
  退出 1，请求 4；等待环境 followup 超时。诊断为“等待唤醒超时”，
  会话日志中环境消息 1、`next-turn` 环境消息插入 0，最后一条助手文本长度 3、
  最后结束原因 `completed`；没有可关联的唤醒轮结束原因。
  那条助手消息不能证明它属于唤醒后的轮次，故不能声称唤醒后正常回复。
  此次超时发生在脚本断言后台 bash 命令之前，也不能据此确认模型是否执行了指定命令，
  或把失败确定归因于业务实现。

## 3. 真实 agent 调用 `env_state` — 通过

第 1 条第二次命令在 DOM 等级断言之前通过此项：会话日志包含真实 agent
`tool/call`，以 call ID 匹配真实 DSH 执行器的 `tool/result`，结果无错误；
JSON 的 `self.body` 中 CPU、内存、磁盘、网络、DSH 进程均有字符串 `status`
及 `value`、`source`。该项不是直接调用工具注册定义。

## 4. 真实宿主文件监视和延迟 — 通过

`DSH_ROOT=$DSH_ROOT ASI_E2E_NO_MODEL=1 ASI_E2E_FILE_TEST=1 pnpm --filter asi-sense exec tsx scripts/e2e-dsh.ts`：
最终退出 0，请求 0。真实 DSH 加载 bundle 和文件规则，测试插件通过 DSH
agent registry 创建五个独立真实会话；模型预算门禁拒绝会话初始化请求，
文件事件后的真正 DSH `next-turn` inbox 插入由会话日志验证，未请求模型。
原子 rename 覆盖及之后追加写入产生两个 DOM 事件，文件来源 `files:e2e-agent-file`
在侧栏为正常。五次取样均命中各自文件的环境 inbox 记录：

| 测量边界（毫秒） | 五次 | p50 | 最大 |
|---|---|---:|---:|
| 文件操作开始 → 侧栏事件节点进入 DOM | 792, 796, 291, 291, 85 | 291 | 796 |
| 文件操作开始 → 真实 DSH 会话 inbox 插入 | 5069, 5067, 5077, 5102, 5087 | 5077 | 5102 |

DOM 测量以节点 attached 为终点，不保证折叠分组已展开；inbox 测量通过
250 ms 轮询持久会话日志，包含轮询误差。五个 DOM 样本均小于 2 秒，
投递延迟约为 5 秒合并窗口。无模型模式不验证文件唤醒后的模型回复。

## 5. 清理 — 通过（有一次中间清理告警）

测试前已有用户 DSH PID 5459；测试结束后仍为 PID 5459，未操作它。
记录到的本任务 DSH / helper PID 分别为
5955/5977、8063/8085、9148/9162、9991/9999、11133/11172、
13693/13739、15663/15670；最终 `ps` 对这些 PID 仅返回用户 PID 5459，
没有本任务 helper 或 Playwright Chromium profile 进程。
两次早期 b1 运行未记录各自 PID，但退出时各自的工作树 helper 检查均为 0。
所有运行均报告临时 profile 删除；最终文件测和 b2 测还在删除后检查路径不存在。
一次早期文件调试运行报告浏览器或 DSH 清理失败，随后复查该 DSH 进程组为空；
不将该次告警掩盖为当时清理成功。

## 其他验证、模型预算与未覆盖

- `pnpm --filter asi-sense exec vitest run test/dsh/e2e-support.test.ts`：退出 0，
  8 测试通过，覆盖 b2 三类诊断及成功和重复唤醒。
- `pnpm check`：最终退出 0；typecheck、Biome 通过，body-probe 215、
  sense-ui 297、asi-sense 647 测试通过。前两次检查分别发现测试脚本的
  ES2022 类型兼容及格式问题，修正测试脚本后最终通过。
- 模型请求计数：b1 第一次 2、b1 第二次 3、b2 第一次 4、b2 复测 4，
  共 **13/16**；每次预算均不超过 6。其余运行请求 0。
- 未验证：b2 指定后台工具是否执行、是否恰好一次唤醒以及唤醒后的模型回复；
  按协调端指示，诊断复测失败后没有再重跑 b2。
