# ASI 设计文档

状态：草案 v0（2026-11-15），P0 可行性验证前。凡标「待 P0 验证」的结论都还没在真实 DSH 里跑过。

## 0. 兼容版本

- DSH：`deepseek-ai/deepseek-harness` `master@39163dd3`（2026-11-13）调研所得。P0 确认 MacPro 实际安装版本后写入本节，并写进各包 `engines.dsh`。
- macOS：MacPro 实机版本（P0 记录）。

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
| `env_state({ section? })` | 返回状态快照（带每条事实的 status/年龄），默认省略窗口标题若隐私开关关闭 |
| `env_watch({ action: 'list'|'add'|'remove', rule? })` | 管理关注规则；`add` 一条 `wake` 规则进入"待用户确认" |
| `env_detail({ app?, window? })` | 需要细节时委托给 DSH 已有的 computer-use 能力（受其授权流程约束）；本插件不自己截图 |

### 2.6 侧栏界面

左侧栏注册一个图标（`sidebar.panellist`，`id: 'asi-sense'`），对应 `main` 区域面板，三个区块：

1. **现在**：四个"在哪里"、前台应用/窗口、活动任务、agent 自身状态；每项显示新鲜度（ok/过期/无权限），无权限项给出授权引导按钮（打开系统设置对应页，不弹系统对话框）。
2. **事件流**：最近的信号，标出等级（记录/注入/唤醒/已抑制）和原因（命中哪条规则、是否自因）。这是调试注意力规则的主要工具。
3. **规则**：列表、启停、编辑；agent 提议的 `wake` 规则在这里确认。另有全局开关：暂停感知、窗口标题是否发给模型。

数据通道：宿主插件暴露 Remote API（`TypertRemoteService`），客户端订阅状态变化和事件流。

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
| 实机 | MacPro 上真实 helper：切换应用、保存文件、跑一个必失败的测试，断言 agent 被唤醒且只被唤醒一次；测量信号到投递延迟（目标 p95 < 500ms，不含合并窗口）。 |
| 循环防护 | 让 agent 执行"写文件"工具，断言不产生 wake。 |

## 6. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| **P0 可行性** | MacPro 上 DSH 安装与版本；最小 bundle（宿主+客户端）出现在左侧栏；Remote API 宿主→客户端推数据；宿主插件对当前会话 `inject`/`followup` 生效；最小 Swift helper 输出应用激活 NDJSON | 每项给出命令与真实输出/截图；不通的项给出替代方案 |
| M1 骨架 | monorepo、`pnpm check`、sense-types、状态库 + 注意力管线（纯逻辑，全单测） | 单测覆盖 §2.3 全部规则 |
| M2 信号源 | helper（NSWorkspace + AX）、文件监视、jobs/工具退出 | 实机验收 |
| M3 投递与工具 | inject/followup/send、`env_state`/`env_watch`/`env_detail`、系统提示段 | 集成测试：测试失败场景端到端 |
| M4 侧栏 | 三个区块、授权引导、开关 | Playwright 截图验收 |
| M5 打包 | `dsh plugin add` 安装即用，`engines.dsh` 固定 | 新 profile 里从零安装验收 |

## 7. 未决问题

1. `createUserMessage` 的 `source.kind` 是否允许自定义值（影响 §2.4）。
2. 宿主插件如何拿到"当前活跃会话"——是订阅 `agent/created` 自己维护，还是 DSH 有现成的当前会话服务。
3. 多会话时信号投递给谁：首版只投给最近活跃的一个会话，规则可指定会话。
4. 状态持久化用 JSON 还是 SQLite（看 DSH 有没有现成存储服务）。
