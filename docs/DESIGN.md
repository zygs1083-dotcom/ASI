# ASI 设计文档

状态：草案 v0（2026-11-15），P0 可行性验证前。凡标「待 P0 验证」的结论都还没在真实 DSH 里跑过。

## 0. 兼容版本

- DSH：`0.2.2-rc.3`，commit `39163dd30f703a79079e2d2446545cff3c453738`（P0 在 MacPro 源码安装验证，见 `docs/spikes/P0.md`）。各包 `engines.dsh` 写 `0.2.2-rc.3`。
- macOS 15.7.7（24G720），Node 26.13.0，Swift 6.2.4（arm64）。
- P0 带来的约束：
  - `contextWindow` 可能是 DSH 的 1,000,000 回退值而非真实容量（magpie 广告 256000）。Token 读数必须带来源标记 `configured | catalog | fallback`，回退值在侧栏标"未确认容量"，不参与阈值告警。
  - Remote API 的 Typert 生成器在 DSH 源码外需要 shim；M2 固定生成器版本并完善外部类型映射。
  - 同 kind 的 inject 不唤醒、followup 新开一轮，已实测；source.kind 用 `environment`。

## 1. 总体

ASI = 一组 DSH 组合包。每个包 = 宿主插件（Node，跑在 DSH 进程里）+ 可选 web 客户端插件（侧栏界面）+ 可选原生 helper。插件之间只通过 DSH 服务（`ctx.*`）和 `packages/` 里的共享类型协作，不互相 import 内部实现。

第一个包 **`asi-sense`：环境感知与触发**。它回答三个问题：

1. 环境刚刚发生了什么？（持续观察）
2. 我（agent）和我所处的环境现在是什么状态，这些信息可信吗？（状态模型）
3. 这件事值得让 agent 知道吗？值得叫醒它吗？（注意力）

核心原则：**平时只收轻量信号，需要细节时再调用现成的界面读取/截图能力**；不做"每秒截图再给模型看"。

## 2. 架构

```
 信号源 (sources)            状态库 (state)             注意力 (attention)          投递 (delivery)
 ─────────────────          ───────────────            ──────────────────          ───────────────
 macOS helper ──┐           self / env / observation   规则匹配 → 等级:            record  → 只进状态库
 文件监视      ──┼─ Signal ─▶ 每条事实带来源/时间/TTL ─▶  record | context | wake ─▶ context → agent.inject()
 DSH 事件      ──┘           /权限/位置                  合并·去重·限流·自因抑制     wake    → agent.followup()/send()
                                    │                                                      │
                                    └──────── Remote API ──▶ 侧栏面板（实时状态/事件流/规则） ◀┘
 模型工具：env_state（读状态）、env_watch（增删关注规则）、env_detail（按需调 computer-use 取细节）
```

### 2.1 信号源

所有信号统一成：

```ts
interface Signal {
  id: string;            // 单调 id
  kind: string;          // 'app.activated' | 'window.focused' | 'file.changed' | 'job.exited' | ...
  at: number;            // 发生时间（ms）
  source: SourceRef;     // 哪个信号源、哪台机器
  subject: string;       // 归并键：bundleId / 绝对路径 / jobId
  data: Record<string, unknown>;
  cause?: 'agent' | 'user' | 'unknown';  // 自因标注，见 2.3
}
```

| 源 | 实现 | 权限 | 首版 |
|---|---|---|---|
| 应用激活/启动/退出 | Swift helper：`NSWorkspace.didActivateApplicationNotification` 等 | 无需 | 是 |
| 焦点窗口标题变化 | Swift helper：`AXObserver` 订阅前台应用 `kAXFocusedWindowChangedNotification`、`kAXTitleChangedNotification` | 辅助功能 | 是（无权限降级为 `denied`） |
| 文件变化 | Node `fs.watch`（FSEvents），只监视规则里列出的路径 | 无需 | 是 |
| 任务/进程结束 | 订阅 DSH `jobs` 与 `tools/post-execute`（shell 工具退出码） | 无需 | 是 |
| 空闲/锁屏/休眠 | helper：`NSWorkspace` 睡眠/唤醒、屏幕锁通知 | 无需 | 第二批 |

- helper 是一个独立的小 Swift 命令行程序，stdout 输出 NDJSON，宿主插件用 `child_process` 拉起并负责生命周期（插件卸载即杀掉）。不复用 `dsh-cua-macos` 的 helper：它是 computer-use 用的，权限更大（含录屏），且一次只允许一个 provider；我们只需辅助功能。
- AX 通知不是所有应用都支持：helper 对每个应用记录"订阅成功/失败"，失败时该应用的窗口信息标为 `unsupported`，只保留应用级信号。不靠轮询补。
- 非 macOS 环境：helper 源不加载，状态里标 `unavailable`，其他源照常工作（便于在 Linux 上跑单测）。

### 2.2 状态模型

状态库是内存中的事实表 + 本地持久化（插件数据目录，JSON/SQLite 待定），分三部分：

```ts
interface Fact<T> {
  value: T | null;
  status: 'ok' | 'stale' | 'denied' | 'unsupported' | 'unavailable' | 'unknown';
  source: SourceRef;       // 来自哪个接口
  observedAt: number;      // 什么时候获取
  ttlMs: number;           // 多久后视为过期（stale 由读取时计算，不靠定时器）
}

interface SenseState {
  self: {
    activity: Fact<'idle' | 'thinking' | 'tool' | 'waiting-user'>;  // 来自 agent/status
    pending: Fact<{ inbox: number; jobs: number }>;
    tools: Fact<string[]>;                // 当前可用工具
    permissions: Fact<Record<string, 'granted' | 'denied' | 'unknown'>>;
  };
  env: {
    where: {                              // 四个"在哪里"分开记，不混为一谈
      model: Fact<{ provider: string; endpoint: string; local: boolean }>;
      harness: Fact<{ host: string; os: string; pid: number }>;
      observed: Fact<{ host: string; userSession: string }>;   // 被观察的电脑
      toolExec: Fact<{ host: string; cwd: string }>;           // 工具实际在哪执行
    };
    frontApp: Fact<{ name: string; bundleId: string }>;
    focusedWindow: Fact<{ title: string }>;                    // 隐私开关见 §4
    activeJobs: Fact<JobSummary[]>;
    watchedPaths: Fact<Record<string, { lastChange: number; changes: number }>>;
  };
  observation: {
    sources: Record<string, { status: Fact<unknown>['status']; lastSignalAt: number; error?: string }>;
  };
}
```

- 宿主插件和侧栏共用这份类型，放在 `packages/sense-types`。
- `where` 四项分开，是为了以后 harness 与被观察机器不是同一台（远程 DSH、SSH 工具执行）时不出错；首版四项通常相同，但必须分别填写来源。
- 当前事实按事件及定时刷新。DSH 固定版 `packages/core/agent/src/runtime-types.ts:61,77-79,133-140,194-205,400` 提供会话模型、收件箱、idle/running 和流事件；Gateway 的待响应转发事件可识别等待用户（`packages/api/gateway/src/types.ts:148-165`）。其他 running 阶段不能推测；工具执行事件和注册表见 `packages/core/tools/src/events.ts:18-49`、`packages/core/tools/src/index.ts:245-255,299-307`，条件工具只在步骤 admission 时确定，面板仅列当前可确认可执行项。
- 任务列表按各会话及无主任务合并去重（`packages/jobs/jobs/src/index.ts:116-121`、`packages/jobs/jobs/src/view.ts:72-87`）。模型 endpoint 只采用配置服务的脱敏显式 `baseURL`（`packages/llm/llm/src/index.ts:566-572`、`packages/llm/llm/src/types.ts:247-280`、`packages/settings/settings/src/index.ts:298-330`），只展示 origin，不把缺省或可能因模型不同而改变的地址当成实际地址。
- 本机 Harness 信息来自 Node，观察会话标为本机控制台会话而非用户名。DSH 的 subprocess 服务将执行目标身份留给 provider（`packages/subprocess/subprocess/src/index.ts:100-106`），所以不能仅凭会话工作目录推断实际工具执行宿主；缺少可核实宿主时该事实显示原因。辅助功能权限来自 helper，其余权限未知；关注路径来自已启用的 `file.changed` 规则；全盘监视另见 §2.8。

### 2.2b 身体状况（vitals）

负责人要求（2026-11-15）：把装了插件的 agent 当成一个人，机器资源和 token 就是它的身体状况，会影响"生命"。侧栏必须展示，状态库里作为 `self.body` 一等公民：

```ts
interface Body {
  cpu: Fact<{ usage: number /* 0..1 */; perCore: number[]; load1: number; load5: number; load15: number }>;
  memory: Fact<{ total: number; used: number; pressure: 'normal' | 'warn' | 'critical'; swapUsed: number }>;
  disks: Fact<Array<{ mount: string; total: number; free: number }>>;   // 至少根卷 + 工作目录所在卷
  battery: Fact<{ percent: number; charging: boolean; minutesLeft?: number } | null>;  // 台式机为 null
  thermal: Fact<'nominal' | 'fair' | 'serious' | 'critical'>;           // ProcessInfo.thermalState，经 helper
  network: Fact<{ online: boolean; rxBps: number; txBps: number }>;
  harnessProcess: Fact<{ rss: number; cpu: number; uptimeSec: number }>; // DSH 自身进程
  tokens: Fact<{
    contextWindow?: number;      // ctx.llm.resolveModelInfo().context 或 contextPressure.contextWindow
    contextUsed?: number;        // ctx.tokenMeter.contextPressure(session).pressureTokens
    contextProjected?: number;   // projectedTokens：下一次请求的规模
    sessionUsage: { input: number; output: number; cacheRead: number; cacheWrite: number };  // tokenUsage 投影
    balance?: { amount: number; currency: string; source: string };  // 提供方余额，只有提供方有接口时（如 DeepSeek 官方 /user/balance）
  }>;
}
```

- "所剩 token"分三层显示，缺哪层就标 `unavailable`，不编造：
  1. **上下文余量**（最像"体力"）：`contextWindow - contextUsed`，以及距自动压缩阈值的距离；
  2. **本会话消耗**：输入/输出/缓存命中，按 `tokenUsage`；
  3. **账户余额**：只在提供方有余额接口时查询（低频，默认 10 分钟一次），本地网关（magpie）通常没有。
- 采集：CPU/内存/负载/进程用 Node `os`/`process`（CPU 用两次采样差值）；内存压力用 `vm_stat` + `sysctl kern.memorystatus_vm_pressure_level`；磁盘用 `fs.statfs`；电池 `pmset -g batt`；温控状态由 Swift helper 订阅 `ProcessInfo.thermalStateDidChangeNotification`。默认 2s 采样一次供侧栏实时显示，**只有越过阈值才产生 Signal**（例如内存压力进入 warn、磁盘剩余 < 10%、上下文余量 < 15%、电量 < 15% 且未充电），这些默认等级为 `context`，进入 critical 的为 `wake`。
- 侧栏把这些画成"体征"：每项一个带阈值色的仪表/迷你走势图（最近 5 分钟），整体给出一个"健康度"概览（取各项最差状态）。

### 2.2c 动态阈值与自我调节

负责人要求（2026-11-15）：除了固定阈值，还要识别"单位时间内的过量增长/过量删除"等变化；阈值随安装时间越久越准；并且由 AI 自己动态调整。

身体告警分三层，同一指标可同时挂多层，任一层触发即产生 Signal：

| 层 | 判断 | 例子 | 可否被 AI 调整 |
|---|---|---|---|
| **安全底线** | 固定绝对值 | 磁盘剩余 < 2%、上下文余量 < 3%、内存压力 critical、thermal critical | **不可放宽**，只能收紧 |
| **变化率** | 滑动窗口内的增量/斜率 | 磁盘 1 分钟少 2GB；关注目录 1 分钟删除 > 50 个文件；RSS 5 分钟涨 50%；token 消耗速率推算"N 分钟后上下文满" | 可调（在边界内） |
| **基线异常** | 与学到的"平时"比 | CPU 在平时安静的时段持续高于基线 3σ；网络流量突然是平时的 10 倍 | 可调（在边界内） |

- **基线学习**：每个指标按"一周内的小时"（168 个桶）维护稳健统计（EWMA 均值 + 中位数绝对偏差 MAD），持久化在本地。安装后前 24 小时为"学习中"（侧栏显示进度），只用安全底线和默认变化率；样本越多置信度越高，置信度进入阈值计算（样本少时阈值放宽，避免误报）。
- **新增的变化类信号**：`body.rate`（指标、窗口、增量、斜率、推算到达底线的时间）、`body.anomaly`（指标、当前值、基线、偏离度）、`file.burst`（目录、窗口内新增/修改/删除计数，"过量删除"即删除数越界）。
- **AI 自我调节**（工具 `body_tune`）：
  - agent 可以调整变化率阈值、异常灵敏度（σ 倍数）、合并窗口、某指标的投递等级，也可以给某次告警打反馈（`useful` / `noise`）。
  - 反馈驱动自动调整：同一规则连续被标 `noise` 会自动降低灵敏度；被标 `useful` 的保持或提高。
  - 护栏：数值调整幅度一般 ≤ ±50%，合并窗口例外见下表；每个参数每小时最多调 2 次；安全底线只能收紧；所有调整写入"调整日志"（谁、何时、旧值→新值、理由），侧栏可查看和一键撤销；负责人可以"锁定"任一参数，锁定后 AI 不能改。
  - 调整立即生效，不需要用户确认（区别于"新增 wake 规则需确认"：调参在护栏内，新增唤醒是扩大打扰范围）。
  - 护栏细则（2026-11-15 评审后协调端定稿，负责人可改）：
    - 次数：AI（agent 与反馈自动调参都算）每个参数每小时 ≤2 次、每天 ≤6 次；所有参数合计每天 ≤24 次。窗口按**单调时钟**滚动；跨重启用持久化的调整日志按墙钟保守恢复（墙钟回拨时按"已用满"处理，前跳不清零）。
    - 身份：`user` 来自宿主可信边界（侧栏操作），`agent`/`auto` 来自工具调用；身份由宿主决定，不由调用参数自报。只有 `user` 能锁定/解锁/放宽安全底线；用户撤销不受 AI 的次数和幅度限制，但同样写日志。
    - 安全底线：每个底线参数绑定收紧方向，AI 的提议对**当前生效值**检查，只能更严格。
    - 持久化：基线、调整日志、锁、计数、ID 序号原子保存到本地；恢复失败（损坏/未知版本）时**禁用 AI 调参**并在侧栏提示，基线从零学习，不当作首次安装放开护栏。调整日志中可撤销的已生效变更不因截断丢失。
    - 学习期：安装后满 24 小时才启用基线异常；之后每个桶至少 8 个有效样本、且覆盖 ≥2 个不同日期才参与判断，不足时该桶不出异常。
    - 时段桶按**本地时间**（一周内的本地小时）计算，时区标识随状态持久化；夏令时跳过/重复的小时按本地小时归桶，时区变化时沿用本地小时语义，不迁移旧数据。
    - 默认变化率规则内置（不依赖外部注入）：磁盘 1 分钟少 2GB、关注目录 1 分钟外部删除 >50、RSS 5 分钟涨 50%、上下文按 token 速率推算 ≤10 分钟满。
    - 注意力调参护栏（2026-11-16 协调端裁决）：
      `disk-eta` 和 `context-critical-eta` 仅存在于未发布分支，用户规则无需兼容这两个 ID。

      | 参数 | 默认 | 绝对范围 | AI 单次调整 |
      |---|---|---|---|
      | `mergeWindowMs` | 2000ms | 1000–30000ms | 当前值的 0.5–2 倍 |
      | `fileMergeWindowMs` | 5000ms | 1000–60000ms | 当前值的 0.5–2 倍 |
      | `rate.context.maxEtaMs` | 600000ms | ≥600000ms | 只能调大，提高灵敏度；10 分钟硬预警不可放宽 |
      | `deliveryLevel.body.rate` / `deliveryLevel.body.anomaly` | context | record、context | record 与 context 间切换，不得升为 wake |
      | `deliveryLevel.file.burst` | wake | record、context、wake | 可从 wake 降为 context/record，或在 record 与 context 间切换，不得升为 wake |

      窗口变更后，未尝试的在途桶按原截止时间与「首次收到时间 + 新窗口」的较早者截止；已尝试的桶保留重试截止与内容，新桶使用新窗口。等级仅影响后续匹配的内置告警规则，不改用户规则、不改变已入桶等级；管线不降级 critical 和预计 10 分钟内耗尽的告警。用户批准的 wake 规则仍按原规则生效。
    - 持久化提交语义（2026-11-16 复审后补）：每个 DSH home 假设仅有单个进程写入，备份后的校验与恢复标记保存之间不协调其他写者。宿主存储端口 `save` 只有在新快照**未**安装时才 reject（原子 rename 是最后一步，之后的目录 fsync 等错误由端口记录、不 reject）。安全关键变更（应用调参、锁、撤销、重学确认）await 保存成功才返回 applied；保存失败 → 本进程禁用 AI 调参，并尽力写入"最后已确认状态 + 禁用标记"（**不得**丢弃已确认的值、锁、预算、可撤销记录）；重启后存储可读写即恢复。被拒绝的提议只进展示日志，不同步落盘、不占持久化 ID 序号；已生效历史只保留可撤销窗口（30 天或 200 条，取多者）。
    - 新工作负载（2026-11-16 复审后改，替代"连续 3 天自动重学"）：基线**从不**用告警期样本自动替换。同一桶在 ≤21 天内的 3 个不同本地日期都处于告警、期间该桶有读数的每次出现都在告警、且候选样本 ≥8 个时，产出"重新基线建议"（侧栏可见，并以 context 告诉 agent）；**只有用户**在侧栏确认后才替换该桶（计入调整日志、可一键撤销，撤销时连同该指标的告警状态一并恢复，确认后立即用新桶重新判定）。agent 可以向用户解释建议，但不能代为确认。理由：持续故障（如内存缓慢泄漏）与永久新负载在数据上不可区分，必须由人判断。
    - 默认投递等级：`body.rate` 与 `body.anomaly` 为 context；`file.burst` 外部删除越界为 wake（系统内置规则，视为已批准）。agent 自己造成的文件变化不计入 burst，纯自因只记录。
- 侧栏：每个体征显示当前阈值来源（底线 / 变化率 / 基线）、基线带（走势图上的阴影区间）、学习进度；"调整日志"作为规则区块的子页。

### 2.3 注意力

每条 Signal 进入后按顺序处理：

1. **更新状态库**（总是做）。
2. **自因判定**：agent 正在执行工具（`tools/pre-execute` 到 `tools/post-execute` 之间）期间产生的文件变化/进程事件，若路径或进程与该工具调用相关（cwd 下、由该 shell 产生），标 `cause: 'agent'`，默认不升级。防止"agent 写文件 → 触发唤醒 → agent 又写文件"的循环。
3. **规则匹配** → 等级：
   - `record`：只记录（默认，例如切换到浏览器）。
   - `context`：攒进"待注入增量"，在 agent 下一次 `agent/pre-step` 前合并成一条消息 `inject()`（不唤醒）。
   - `wake`：立即（经合并窗口后）`followup()` 唤醒；agent 正忙时用 `send(m, 'next-step', true)` 插到下一步。
4. **合并与限流**：
   - 同一 `subject` 在合并窗口（默认 2s，保存文件类 5s）内的多个信号合成一条（"a.ts 保存了 3 次"）。
   - `wake` 预算：每会话默认每 10 分钟最多 3 次、两次之间至少 60s；超出降级为 `context`，并在侧栏显示"已抑制 N 次"。
   - 用户正在和 agent 对话（`waiting-user` 以外的活跃轮次由用户发起）时，`wake` 降级为 `next-step` 注入，不另开新轮。
   - 无会话归属的环境变化投给侧栏当前目标；会话自己的任务等主事件始终归属原会话，不随目标切换。预算按实际接收会话计算。切换目标时未确认的无归属桶按现有转桶机制迁移，不重复投递；已确认的投递不撤回。

规则形式（用户在侧栏编辑，模型用 `env_watch` 提议，**模型新增的 `wake` 规则需用户在侧栏确认后才生效**）：

```ts
interface WatchRule {
  id: string;
  match: { kind: string; subject?: string /* glob */; where?: Record<string, unknown> /* 例如 exitCode != 0 */ };
  level: 'record' | 'context' | 'wake';
  note?: string;          // 唤醒时附给模型的说明："测试失败时看日志并决定是否提醒我"
  createdBy: 'user' | 'agent';
  expiresAt?: number;
}
```

内置默认规则：

| 事件 | 等级 |
|---|---|
| 应用切换、窗口标题变化 | record |
| 关注路径下的文件保存 | context（合并） |
| 关注的任务/进程非 0 退出 | wake |
| 关注的任务/进程正常结束 | context |
| 信号源状态变为 denied/error | context（一次） |

### 2.4 投递格式与 KV Cache

- **不改系统提示词**来传递动态状态（每次变化都会让前缀缓存失效）。系统提示里只放一段固定的说明（`ctx.systemPrompt.section`）：有哪些 env 工具、`<env-update>` 消息是什么意思。
- 动态变化用消息投递，正文是紧凑的增量：

```
<env-update since="12:01:03" source="asi-sense">
front-app: Safari (was: Terminal)
file: src/app.ts saved ×3
job: `pnpm test` exited 1 after 42s  [rule: test-fail → wake]
note: 测试失败时看日志并决定是否提醒我
</env-update>
```

- 消息 `source: { kind: 'environment' }`（待 P0 确认 DSH 是否接受自定义 kind；不接受则用 `schedule` 一类已有 kind 并在正文标识）。
- 完整状态不主动推，模型需要时调用 `env_state`。

### 2.5 模型工具

| 工具 | 作用 |
|---|---|
| `env_state({ section? })` | 返回状态快照（带每条事实的 status/年龄）和 `deliveryTarget` 模式（`auto` / `pinned`，不含会话标题）；默认省略窗口标题若隐私开关关闭 |
| `env_watch({ action: 'list'|'add'|'remove', rule? })` | 管理关注规则；`add` 一条 `wake` 规则进入"待用户确认" |
| `env_detail({ app?, window? })` | 需要细节时委托给 DSH 已有的 computer-use 能力（受其授权流程约束）；本插件不自己截图 |

### 2.6 侧栏界面

左侧栏注册一个图标（`sidebar.panellist`，`id: 'asi-sense'`），对应 `main` 区域面板。标题下的「投递到」支持按标题搜索对话并显示最近活动时间；默认自动选择最近活跃会话，也可固定一个目标（§7.3）。其下有四个区块：

0. **身体**（置顶）：健康度概览 + CPU、内存（含压力）、磁盘、电池、温控、网络、DSH 进程、token（上下文余量环形图 + 会话消耗 + 余额）；数值实时刷新，带 5 分钟迷你走势图和阈值配色。
1. **现在**：四个"在哪里"、前台应用/窗口、活动任务、agent 自身状态；每项显示新鲜度（ok/过期/无权限），无权限项给出授权引导按钮（打开系统设置对应页，不弹系统对话框）。
2. **事件流**：最近的信号，标出等级（记录/注入/唤醒/已抑制）和原因（命中哪条规则、是否自因）。这是调试注意力规则的主要工具。
3. **规则**：列表、启停、编辑；agent 提议的 `wake` 规则在这里确认。另有全局开关：暂停感知、窗口标题是否发给模型。

数据通道：宿主插件暴露 Remote API（`TypertRemoteService`），客户端订阅状态变化和事件流。

### 2.8 0.1.4 产品决定（2026-11-17，负责人定）

**文件监视默认全盘（负责人 2026-11-17 改定，取代原「只看授权目录」）**
- 默认监视整个磁盘（FSEvents，根 `/`，含用户目录与外接卷可选），只记录路径与增/改/删，**不读文件内容**。默认排除：`/System`、`/Library`、`/private`、`/dev`、`/usr`、`/bin`、`/sbin`、`/cores`、`/opt/homebrew`、`~/Library`、`~/.Trash`、任意层级的 `node_modules`、`.git`、`.cache`、`Caches`、`DerivedData`、`.pnpm-store`、`__pycache__`，以及 DSH 数据目录与本插件自己的数据目录（防自激）。侧栏可查看/增删排除项、整体关闭全盘监视。
- 如需「完全磁盘访问」才能收到受保护目录（桌面/文稿/下载等）的事件：不弹系统对话框，侧栏显示该范围 `denied` 并给授权引导；拿不到时其余范围照常工作。
- 事件量控制：全盘变更在源头按「目录 × 时间窗」聚合为 `file.activity`（目录脱敏、增/改/删计数、top 若干文件名），不逐文件进入注意力管线与历史；默认等级 `record`（不发给模型）。外部大批删除仍由 `file-burst-external-deletion` 判定为 `wake`。原有「用户指定目录」规则保留，命中时按原 `file.changed` 等级（context）。
- 资源预算：稳态 CPU < 1%、内存增量 < 50 MB；超预算自动降级（加大聚合窗、只保留计数）并在侧栏提示。

**事件历史保留 30 天 + 每月一份总结**
- 事件按天写入插件数据目录 `history/events/YYYY-MM-DD.jsonl`（仅本机，权限 0600），启动时加载、超过 30 天的整天文件删除；单日超 20 MB 停止写入当天明细并记一条 `source.error`。侧栏提供「清除历史」。
- 事件记录保留应用名（脱敏后）作为 subject；窗口标题照常本地记录，是否给模型仍受「窗口标题发给模型」开关控制。
- 每天结束（或启动时补算）把当天明细汇总为日汇总 `history/daily/YYYY-MM-DD.json`：各应用前台时长与切换次数、告警/唤醒次数及规则、文件 burst 计数（按脱敏目录）、身体异常次数、观测覆盖时长（感知暂停/DSH 未运行的时间单列）。日汇总保留 400 天。
- 月度总结由当月日汇总合成（因明细只留 30 天，不依赖原始事件），在跨月后首次运行时生成 `history/monthly/YYYY-MM.json`，长期保留；**纯本地统计，不调用模型**。侧栏可查看；模型通过工具按需读取。
- 新模型工具：`env_history({ from?, to?, kinds?, app?, limit? })`（最多 200 条，输出走同一脱敏投影）、`env_summary({ month? })`。不主动把总结推送给模型。

### 2.7 M3/M4 集成契约（2026-11-16 协调端定稿）

分层（只依赖上一层的公开 API，不互相 import 内部实现）：

1. **runtime**（`plugins/asi-sense/src/host/runtime/**`、`src/host/sources/**`）：纯 Node，不 import Cordis/DSH。`createSenseRuntime(ports, options)` 组合 body-probe 采样、helper 子进程、文件监视、StateStore、AttentionPipeline、BodyMonitor、持久化与单一 deadline 定时器（取 pipeline/body/TTL 的最早 deadline，墙钟只用于展示）。所有外部依赖经端口注入：
   - `DshPort`：`onAgentEvent(cb)`（created/disposed/pre-step/post-step，带 sessionId）、`onTool(cb)`（pre/post-execute：sessionId、toolCallId、pid?、cwd?、exitCode?、command 摘要）、`onJob(cb)`、`deliver(sessionId, intent)`（inject / followup / send-next-step，返回 Promise）、`tokenSnapshot(sessionId)`（contextUsed、contextWindow、contextWindowSource、sessionUsage）。
   - `StoragePort`：`load(key)`/`save(key, json)`，save reject ⇔ 未安装（§2.2c 持久化提交语义）。
   - `HelperSpawner`、`ProbeFactory`、`FileWatcher`、`Clock{wall(), mono()}`：测试用假实现。
   - 会话选择（§7.3）：自动模式投给最近一次 pre-step 的活跃会话；固定模式投给用户选定的会话。无会话时 context 留桶、wake 记录为 suppressed(no-session)；带归属的主事件始终留在所属会话。
   - 存储实现（2026-11-16）：DSH `storage-json` 的 atomic 写在 rename 之后还会因目录 fsync 失败而 reject，且 storage-domain 在 reject 时回滚内存，不满足"reject ⇔ 未安装"。因此安全关键快照不用 `ctx.storageDomain`，由插件自带 FileStoragePort：tmp → fsync(file) → rename（最后可失败步骤）→ fsync(dir)（失败只记日志）。
2. **presenter**（`src/host/presenter/**`）：把 runtime 公开读接口投影为 `SensePanelModel`（`@asi/sense-ui` 的类型，type-only import），含 5 分钟历史环形缓冲（按 `sampleIntervalsMs` 各序列独立）、insights、learning、tuning、events（最近 200 条，含等级与抑制原因）、rules。输出 `frames(): AsyncIterable<SensePanelModel>`，节流 ≥500ms，同引用复用未变部分。
3. **actions**：`SenseActions`（全部由宿主以 `user` 身份调用，来源只能是侧栏 Remote 调用）：`toggleRule/confirmRule/deleteRule/pause/setSendTitles/openPermissionSettings/revertTuning/lockParam/feedback/acceptRebaseline/resumeTuning/resetTuning`。模型工具（`env_state/env_watch/env_detail/body_tune`）以 `agent` 身份走同一 runtime，不经 `SenseActions`。
4. **dsh**（`src/host/dsh/**`、`src/client/**`、包清单）：唯一 import DSH/Cordis 的层——实现 DshPort/StoragePort（`ctx.storageDomain`）、`TypertRemoteService`（`frames` 为 stream，actions 为 unary）、工具与系统提示段、客户端侧栏挂载 `SensePanel`。

`SensePanelModel.tuning` 扩展（sense-ui 与 presenter 共同遵守）：
```ts
disabled?: { reason: 'storage-failed' | 'restore-failed' }
suggestions?: { id: string; metric: MetricKey; slotLabel: string /* 例 "周二 14 时" */; from: number; to: number; unit: 'ratio' | 'percent' | 'bytes' | 'tokens' | 'bytes-per-second' | 'ordinal'; samples: number; dates: number }[]
// from/to 为运行时自然单位（disk:<mount> = 剩余字节，context = 剩余 token，cpu/memory = 0..1 比例 ratio，battery = 0..100 percent），由 presenter 填 unit，UI 只按 unit 格式化，不换算成 history 单位。
```
危险操作回调（`onResumeTuning`/`onResetTuning`/`onAcceptRebaseline`）返回 `Promise<void>`：UI 在 Promise 未决期间锁定该操作（按钮 disabled + 「处理中」），resolve 后等待新 model 反映结果，reject 时内联显示失败并解锁；打开二次确认时焦点落在「取消」，不落在确认按钮。
UI：disabled 时规则区顶部提示条——storage-failed 给「恢复 AI 调参」（`onResumeTuning`），restore-failed 给「重置调参」（`onResetTuning`，二次确认）；suggestions 列在调整日志上方，每条「确认重新基线」（`onAcceptRebaseline(id)`，二次确认，文案说明"持续故障与新负载无法自动区分"）。

## 3. 目录结构（计划）

```
packages/sense-types/          共享类型（Signal、Fact、SenseState、WatchRule）
plugins/asi-sense/
  package.json                 dsh.bundle + dsh.client + engines.dsh
  cordis.patch.yml
  src/host/                    sources/ state/ attention/ delivery/ tools/ remote/
  src/client/                  侧栏面板
  native/macos/                Swift helper（swift build）
  test/                        vitest（单测用假信号源与假 agent）
```

## 4. 隐私

- 观察数据只在本机：状态库、事件流持久化都在 DSH 插件数据目录。
- 发给模型的只有：注意力规则升级为 context/wake 的增量，以及模型主动调用 `env_state` 的结果。
- 窗口标题默认**发给模型**（否则感知价值大减），侧栏可一键关闭；关闭后只发应用名。
- 不读窗口内容、不截图；`env_detail` 走 computer-use 自己的授权。

## 5. 验证方法

| 层 | 内容 |
|---|---|
| 单测 | 注意力管线的确定性测试：给定信号序列 + 规则 → 断言投递序列（合并、限流、自因抑制、预算降级）。用假时钟。 |
| 集成 | 真实 DSH（`pnpm dsh web --patch`）加载插件，假 helper（回放 NDJSON 夹具）驱动，断言 agent 收到的消息和侧栏渲染（Playwright 截图）。 |
| 实机 | MacPro 上真实 helper：切换应用、保存文件、agent 自己用 shell 工具跑必失败命令 → 不唤醒（自因已抑制，事件流可见）；失败发生在工具窗口之外（后台任务在 post-execute 之后退出，或独立终端进程）→ 断言 agent 被唤醒且只被唤醒一次；测量信号到投递延迟（目标 p95 < 500ms，不含合并窗口）。 |
| 循环防护 | 让 agent 执行"写文件"工具，断言不产生 wake。 |

## 6. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| **P0 可行性** | MacPro 上 DSH 安装与版本；最小 bundle（宿主+客户端）出现在左侧栏；Remote API 宿主→客户端推数据；宿主插件对当前会话 `inject`/`followup` 生效；最小 Swift helper 输出应用激活 NDJSON | 每项给出命令与真实输出/截图；不通的项给出替代方案 |
| M1 骨架 | monorepo、`pnpm check`、sense-types、状态库 + 注意力管线（纯逻辑，全单测） | 单测覆盖 §2.3 全部规则 |
| M2 信号源 | helper（NSWorkspace + AX + thermal）、文件监视、jobs/工具退出、身体采集（§2.2b，含 token） | 实机验收；采样开销 < 1% CPU |
| M2b 动态阈值 | §2.2c：变化率检测、168 桶基线学习、`body_tune` 护栏与调整日志、反馈驱动调参 | 回放合成时序：注入突增/突删能检出、平稳期误报率 < 1 次/天（模拟 7 天）|
| M3 投递与工具 | inject/followup/send、`env_state`/`env_watch`/`env_detail`、系统提示段 | 集成测试：测试失败场景端到端 |
| M4 侧栏 | 三个区块、授权引导、开关 | Playwright 截图验收 |
| M5 打包 | `dsh plugin add` 安装即用，`engines.dsh` 固定 | 新 profile 里从零安装验收 |

## 7. 未决问题

1. `createUserMessage` 的 `source.kind` 是否允许自定义值（影响 §2.4）。
2. 宿主插件如何拿到"当前活跃会话"——是订阅 `agent/created` 自己维护，还是 DSH 有现成的当前会话服务。
3. **会话选择（已定）**：侧栏可搜索当前 profile 的对话并选择固定目标，默认自动（最近一次 pre-step 的活跃会话）。目标与「现在」区块共用 `currentSessionId()`；无归属的 context/wake 及唤醒预算按目标会话处理，切换时转移尚未确认的无归属桶，会话已有的主事件仍只归其原会话。选择按 profile 保存并在重启时恢复；目标关闭、归档或不存在时回退自动、记录事件并在侧栏提示一次。模型的 `env_state` 只暴露目标模式，不暴露会话标题。固定版 DSH 使用 `packages/api/session-controller/src/index.ts:267-285` 列表与恢复接口、`src/list.ts:125-176` 最近活动与运行状态、`packages/session/session-title/src/types.ts:79-86` 标题投影、`packages/core/session/src/index.ts:45-81` 会话事件和 `packages/workspace/workspace/src/index.ts:148-164,355-362` 归档事件及集合。
4. 状态持久化用 JSON 还是 SQLite（看 DSH 有没有现成存储服务）。
