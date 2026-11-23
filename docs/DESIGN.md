# ASI 设计文档（v0.2 · 需求驱动模块化架构）

状态：v0.2 定稿（2026-11-22）。由早期围绕事件规则（`WatchRule`）的单体插件重构为**围绕生存需求与稳态维护**的双插件模块化架构。

## 0. 兼容版本

- **DSH 宿主**：支持的宿主版本恰为 `0.2.2-rc.3` 与 `0.2.2-rc.5`；各包 `engines.dsh` 与 `@deepseek-ai/dsh-*` `peerDependencies` 统一声明 `0.2.2-rc.3 || 0.2.2-rc.5`。开发构建固定针对 `0.2.2-rc.3` 源码提交 `39163dd30f703a79079e2d2446545cff3c453738` 验证。
- **Node**：`^22.12.0 || ^24.0.0 || >=26.0.0`；macOS 原生辅助进程使用 Swift（Apple Silicon `arm64`）。
- **宿主已知约束**：
  - `ctx.llm.resolveModelInfo` 与 `sessionProjections` 在未显式携带来源时返回回退估值，Token 事实统一附带 `contextWindowSource: 'configured' | 'catalog' | 'fallback'`；`fallback` 在侧栏标注「容量未确认（回退估值）」，在心智需求评估中偏紧时仅进入 `uncomfortable` 后台静默整理，避免误报危急啼哭。

## 1. 核心理念与总体分工

ASI 是一组职责正交的 DSH 组合包，插件之间仅通过 Cordis 服务（`ctx.asiSense`）与 `@asi/sense-types` 共享契约通信，不互相引用内部源码：

```
 ┌──────────────────────────────────────────────────────────────┐
 │ asi-sense（纯感官模块 · 无侧栏 UI · 后台 Cordis 服务）        │
 │  ├─ 信号源：macOS Swift helper / BodyProbe / DSH 活动与任务   │
 │  ├─ 状态库：SenseState（每条事实含来源、时间、TTL 与权限状态） │
 │  ├─ 短期趋势环：BodyHistory（内存保留最近 5 分钟体征曲线）     │
 │  ├─ Cordis 服务：ctx.asiSense（快照、订阅、normal/eco 采样）  │
 │  └─ 全局只读工具：env_state / env_detail（绝不主动注入消息）   │
 └──────────────────────────────┬───────────────────────────────┘
                                │ ctx.asiSense.subscribe / setPowerMode
                                ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ asi-needs（婴儿期生存需求与自发维护 · 统一侧栏 UI）           │
 │  ├─ 五大生理需求稳态评估（0..100% 满足度/紧迫度 + 回滞锁）：   │
 │  │    ① 能量 energy  ② 空间 space  ③ 内存与进程 memory       │
 │  │    ④ 心智容量 mind ⑤ 体温负荷 thermals                     │
 │  ├─ 三层自救与交互机制：                                     │
 │  │    Tier 1 零 Token 本能反射（自动 eco 降频 + 静默网关探活） │
 │  │    Tier 2 独立后台自维护会话（仅挂载只读 + 4 项沙盒工具）   │
 │  │    Tier 3 按需啼哭求助（侧栏求助卡 + 单次 <asi-cry> 通知） │
 │  ├─ 普通对话只读工具：needs_status（日常对话零打扰、零越权工具）│
 │  └─ 统一侧栏（id: 'asi-needs'）：生存需求/自发维护/体征/环境  │
 └──────────────────────────────────────────────────────────────┘
```

### 已移除的旧版复杂度（0.2.0 瘦身决定）

为保持纯粹的感官与需求分层，已彻底移除：
- `WatchRule` 事件匹配规则、`env_watch` 工具、注意力合并桶与 `<env-update>` 动态消息推送管线；
- `Tuner` / `body_tune` 告警参数自调、168 小时周桶基线学习与重新基线建议；
- 全盘 FSEvents 文件监视（`globalFileWatch` / `watchedPaths`）；
- 30 天 JSONL 事件明细、400 天日汇总与月度统计报告（`env_history` / `env_summary`）；
- 插件源码自打包与自修改投递箱（`maintenance.ts`）。

## 2. `asi-sense`：纯感官模块

### 2.1 采集范围

1. **身体体征（`self.body`）**：
   - `cpu`（总使用率、每核使用率、`load1/5/15`）、`memory`（总量、已用、`vm_stat` 压力档位、交换区、细分项）、`disks`（各挂载点总量/剩余字节及卷级新鲜度 `status`/`observedAt`/`ttlMs`/`unavailableMounts`）、`battery`（电量百分比、充放电状态、剩余分钟，台式机为 `null`）、`thermal`（`nominal | fair | serious | critical`）、`network`（在线状态与上下行速率）、`harnessProcess`（DSH 自身 RSS、CPU、运行时长）、`tokens`（上下文占用、窗口容量与来源、本会话累计用量、可选余额）。
2. **当前环境快照（`self` / `env` / `observation`）**：
   - 四个位置节点（`env.where.{model, harness, observed, toolExec}` 分离记录）、前台应用（`frontApp`）、焦点窗口（`focusedWindow`）、DSH 活动任务（`activeJobs`）、系统休眠/锁屏状态（`system`）、辅助功能权限（`permissions`）及各信号源健康度（`observation.sources`）。
3. **5 分钟短期趋势环（`BodyHistory`）**：
   - 纯内存环形缓冲保留最近 5 分钟体征序列（含 `disks` 已用率与 `diskFree` 剩余字节序列，供 `asi-needs` 计算磁盘骤降速率与 CPU 持续负荷）。

### 2.2 macOS Helper 瞬态 AX 稳定性契约

- 应用级暂时性 AX 失败（如应用刚启动窗口尚未就绪）由 Swift helper 上报 `error` / `ax-retryable`（携带目标 `pid` 与 `bundleId`），并在下次应用激活或权限复查时自动重试。
- 宿主仅当该错误与当前前台应用身份一致（`bundleId` 相同且已知 `pid` 一致；空 `bundleId` 仅按 `pid` 匹配）且辅助功能未被拒绝时，将 `env.focusedWindow` 与 `helper.ax` 标为 `unknown` 并作废在途旧窗口快照；**不触发 helper 整体重启恢复、不污染温度或前台应用事实、也不覆盖已有的 `denied`/`unsupported` 状态**。

### 2.3 Cordis 服务契约（`ctx.asiSense`）

`asi-sense` 注册 `AsiSenseService`（无客户端 bundle、不占侧栏图标）：
- `snapshot(sessionId?)` / `subscribe(listener)`：提供深拷贝隔离的实时感官快照流；
- `setPowerMode('normal' | 'eco', reason?)`：供 `asi-needs` 本能反射零 Token 切换采样频率（`normal` 2s / `eco` 10s，内部安全停止并重配 `BodyProbe`）；
- `setPaused(paused)` / `setSendTitles(enabled)` / `openPermissionSettings()`：持久化感官开关与系统设置引导；
- `registerInternalSession(sessionId)`：标记后台内部会话（如 `asi-needs` 的自维护会话），使其步骤与工具调用绝不劫持前台活跃会话观察。

## 3. `asi-needs`：婴儿期生存需求与自发维护

### 3.1 五大生存需求与连续稳态回滞模型

每项需求实时计算整数 `satisfaction`（`0..100`）与 `urgency = 100 - satisfaction`，采用施密特触发器回滞（Hysteresis）：
- **危急区（`critical`）**：`satisfaction < 25`，`driveActive = true`；
- **不适区（`uncomfortable`）**：`25 <= satisfaction < 60`，`driveActive = true`；
- **回滞保持区**：一旦 `driveActive` 激活，满足度回升至 `60..69` 期间仍保持 `zone = 'uncomfortable'` 与 `driveActive = true`，持续驱动维护直至彻底恢复；
- **舒适区（`comfortable`）**：恢复至 `satisfaction >= 70`（或从未跌破 `60`）时，`zone = 'comfortable'`，`driveActive = false`，驱动力消除并自动归档该需求下未决的求助卡。

| 需求键 | 名称 | 核心输入指标 | 不适 / 危急典型条件 |
|---|---|---|---|
| `energy` | 能量 | 电池电量与充放电状态、模型网关连通性 | 未插电 `<40%` 或连接波动为不适；未插电 `<15%`、续航 `≤15m` 或网关失联为危急（台式机与充电中豁免低电量） |
| `space` | 空间 | 新鲜有效磁盘卷剩余字节/比例、`diskFree` 5 分钟斜率 | 剩余 `≤10%`/`<15GB` 或高速下降为不适；`≤5%`/`<5GB` 或预计 15 分钟内耗尽为危急（过期卷隔离不误报） |
| `memory` | 内存与进程 | 系统内存压力与占比、DSH 进程 RSS、超时/无主 DSH 任务数 | `warn`/`≥85%`、RSS `≥1.5GB` 或存在残留任务为不适；`critical`/`≥95%`、RSS `≥3GB` 或残留任务 `≥3` 为危急 |
| `mind` | 心智容量 | `tokens` 上下文窗口余量与 `contextWindowSource` | 剩余 `≤20%` 为不适；已确认容量剩余 `≤8%`（或 `fallback` 剩余 `≤2%`）为危急 |
| `thermals` | 体温负荷 | macOS `thermal` 档位、CPU 当前值与 2 分钟均值 | `serious` 或持续 CPU `≥80%` 为不适；`critical` 或持续 CPU `≥92%` 为危急（单点短暂尖峰不误报） |

### 3.2 三层自救权限与安全沙盒边界

1. **Tier 1：零 Token 本能反射（`InstinctController`）**
   - 不消耗任何模型 Token：未插电电量 `≤20%`、温控 `serious/critical`、持续高负荷或模型网关 `offline` 时立即调用 `asiSense.setPowerMode('eco', reason)` 降频省电降温；待相关驱动力完全解除后恢复 `'normal'`（不覆盖用户手动开启的节能模式）。
   - 静默探活：对模型网关 origin 发送无凭据、无请求体的轻量 `HEAD` 探活（指数退避 `10s -> 20s -> 40s -> 60s`，首次失败标 `degraded`，连续失败标 `offline`；硬性跳过受限内网生产地址）。
2. **Tier 2：专用后台自维护会话（`ASI 自维护`）**
   - 仅在存在可自救软件不适/危急或用户点击「立即自检」且网关在线时按需创建（工作目录隔离在 `<storageRoot>/sandbox`，预先通过 `registerInternalSession` 登记）。
   - 受 **120 秒单调时钟冷却**与**每小时最多 6 轮**硬上限约束，防止死循环消耗 Token。
   - **严格工具作用域隔离（`tools.ts`）**：
     - **普通用户对话**：全局仅注册只读工具 `needs_status`（配合 `asi-sense` 的 `env_state` / `env_detail`），**绝不挂载任何维护动作工具，平时绝不注入动态环境消息**。
     - **后台自维护会话**：通过 `agent.ctx.tools.restrict` 剥离 `shell` / `write_file` / `computer_use` 等全部非白名单全局工具，辅以 `agent.ctx.tools.guard` 二次强拦，仅开放 3 个只读诊断工具 + 4 个白名单安全维护工具：
       - `needs_clean_cache`：零路径参数，仅清理插件自有 `<needsStorageRoot>/tmp`、`cache` 与 `<senseStorageRoot>/tmp`，使用 `lstat` 拒绝跟随任何符号链接并校验 `realpath` 包含关系，绝不触碰用户文件或持久化状态；
       - `needs_stop_job`：仅结束运行超 15 分钟或所属会话已销毁的无主 DSH 任务（`ctx.jobs.kill`），严格拒绝正常活跃的用户任务，绝不向外部系统进程发信号；
       - `needs_compact_context`：仅对处于 `idle` 状态的非内部会话调用 `ctx.compaction.compactNow`，并在自维护会话轮次累积后标记轮换；
       - `needs_request_help`：提交经 `sanitizeForModel` 脱敏且按 `(need, actionKind)` 去重的求助卡。
3. **Tier 3：按需啼哭求助（`HelpCard` + `<asi-cry>`）**
   - 仅在触及物理/连接/权限边界（如快断电需插电源、网关失联、严重过热、用户目录大文件占满磁盘）或后台自救后仍处于 `critical` 时触发：
     - 在统一侧栏顶部置顶展示求助卡（提供一键批准动作或「我已处理」/「忽略」）；
     - 向当前活跃的前景用户对话发送紧凑的 `<asi-cry>` 消息（**每次危急剧集每个需求最多发送 1 次**，直到回到舒适区才重置；网关离线时以 `wakeup: false` 驻留队列避免无效请求，在线时 `followup` 提醒）。

## 4. 统一侧栏界面（`@asi/sense-ui` + `asi-needs`）

仅由 `asi-needs` 在 DSH 左侧栏注册唯一入口 **生存需求**（`id: 'asi-needs'`，英文 `Survival needs`）：
- **置顶啼哭求助区**：展示 `open` 状态的求助卡，支持一键批准执行安全动作或确认/忽略；
- **生存需求区**：总稳态横幅（含回滞恢复提示）+ 五大需求满足度/紧迫度计量条与摘要；
- **自发维护区**：本能反射状态（采样档位与网关探活）、后台自维护会话状态、「查看自维护会话」跳转按钮、「立即自检」按钮及最近维护记录；
- **核心体征区**：健康度心电概览 + CPU/内存/Token/磁盘/网络/温控/电池/DSH 进程卡片及 5 分钟趋势折线图；
- **当前环境区**：四节点位置链、焦点应用与窗口（受隐私开关控制）、自身状态、活动任务、辅助功能授权引导与信号源明细；
- **控制与隐私区**：「暂停感知与自维护」与「窗口标题发给模型」开关。

## 5. 隐私与凭据安全

- 所有观察数据与维护状态仅保存在本机 DSH 数据目录（`asi-sense` 与 `asi-needs`）。
- 所有暴露给模型的工具返回值（`env_state`、`env_detail`、`needs_status` 及 4 个自维护工具）与 `<asi-cry>` 文本一律经过线性时间 $O(N)$ 的 `sanitizeForModel` 凭据打码器与主目录 `~` 化保护；关闭「窗口标题发给模型」时，窗口标题既不发给模型也不渲染进侧栏 DOM。
- 发行包构建产物（`asi-sense` 与 `asi-needs`）均强制通过 `release-audit.mjs` 检查（校验文件白名单、零源码映射、零密钥/邮箱/本机用户名/敏感绝对路径残留）。
