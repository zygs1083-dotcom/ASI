# ASI 设计文档（v0.3 · 需求驱动、行动记忆与马斯洛多层仲裁架构）

状态：v0.3 定稿（2026-11-23）。在 v0.2 双插件稳态架构基础上，新增 **MIT 开源规则内化全景病因嗅探与 1 小时活跃保护外部缓存一键批准清理**、**行动效果记忆（Action-Outcome Memory）与零收益静默熔断**，以及 **`ctx.asiDrives` 跨插件马斯洛多层需求仲裁服务**。

## 0. 兼容版本

- **DSH 宿主**：支持的宿主版本恰为 `0.2.2-rc.3` 与 `0.2.2-rc.5`；各包 `engines.dsh` 与 `@deepseek-ai/dsh-*` `peerDependencies` 统一声明 `0.2.2-rc.3 || 0.2.2-rc.5`。开发构建固定针对 `0.2.2-rc.3` 源码提交 `39163dd30f703a79079e2d2446545cff3c453738` 验证。
- **Node**：`^22.12.0 || ^24.0.0 || >=26.0.0`；macOS 原生辅助进程使用 Swift（Apple Silicon `arm64`）。
- **宿主已知约束**：
  - `ctx.llm.resolveModelInfo` 与 `sessionProjections` 在未显式携带来源时返回回退估值，Token 事实统一附带 `contextWindowSource: 'configured' | 'catalog' | 'fallback'`；`fallback` 在侧栏标注「容量未确认（回退估值）」，在心智需求评估中偏紧时仅进入 `uncomfortable` 后台静默整理，避免误报危急啼哭。

## 1. 核心理念与总体分工

ASI 由 `asi-sense`、`asi-needs`、`asi-sleep` 与 `asi-care` 四个独立组合包构成，插件之间仅通过 Cordis 服务（`ctx.asiSense`、`ctx.asiDrives`）与 `@asi/sense-types` 共享契约通信，不互相引用内部源码：

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ asi-sense（0.3.0 · 纯感官模块 · 无侧栏 UI · 后台 Cordis 服务）        │
 │  ├─ 信号源：macOS Swift helper / BodyProbe / DSH 活动与任务           │
 │  ├─ 状态库：SenseState（每条事实含来源、时间、TTL 与权限状态）         │
 │  ├─ 短期趋势环：BodyHistory（内存保留最近 5 分钟体征曲线）             │
 │  ├─ Cordis 服务：ctx.asiSense（快照、订阅、normal/eco 采样）          │
 │  └─ 全局只读工具：env_state / env_detail（绝不主动注入消息）           │
 └──────────────────────────────────┬───────────────────────────────────┘
                                    │ ctx.asiSense.subscribe / setPowerMode
                                    ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ asi-needs（0.3.0 · 生存需求、行动记忆与多层需求仲裁 · 生存需求侧栏）  │
 │  ├─ L1 五大生理需求稳态评估（0..100% 满足度/紧迫度 + 回滞锁）：       │
 │  │    ① 能量 energy  ② 空间 space  ③ 内存与进程 memory               │
 │  │    ④ 心智容量 mind ⑤ 体温负荷 thermals                             │
 │  ├─ Cordis 跨插件仲裁服务：ctx.asiDrives（马斯洛 L1–L4 仲裁器）       │
 │  │    - 供高阶插件（L2 asi-sleep、L3 asi-care）注册需求、工具与回调  │
 │  │    - L1 生理不适或 eco 节能模式时自动压制挂起全部 L2–L4 高阶需求   │
 │  ├─ 三层自救与交互机制：                                             │
 │  │    Tier 1 零 Token 本能反射（自动 eco 降频 + 静默网关探活）         │
 │  │    Tier 2 独立后台自维护会话（全景只读嗅探 + 白名单安全沙盒工具）   │
 │  │    Tier 3 按需啼哭求助（受控一键批准求助卡 + L1 单次 <asi-cry>）   │
 │  ├─ 行动效果记忆（Action-Outcome Memory）与零收益静默熔断             │
 │  ├─ 普通对话只读工具：needs_status（日常对话零打扰、零越权工具）       │
 │  └─ 侧栏面板（id: 'asi-needs'）：生存需求/高阶仲裁/自发维护/体征/环境 │
 └────────────────┬──────────────────────────────────┬──────────────────┘
                  │ ctx.asiDrives (tier: 2)          │ ctx.asiDrives (tier: 3)
                  ▼                                  ▼
 ┌───────────────────────────────────┐ ┌────────────────────────────────┐
 │ asi-sleep（0.3.0 · L2 睡眠整合）  │ │ asi-care（0.3.0 · L3 项目看护）│
 │  ├─ >=12 轮或 >=6h 困意；10m/锁屏 │ │  ├─ 零配置发现 + 兄弟 worktree │
 │  ├─ NREM+REM 双阶段聚类/冲突/修剪 │ │  ├─ 3m/30m 探针 + 2h 活跃豁免  │
 │  ├─ ts-fsrs + MiniSearch 中英检索 │ │  ├─ 三分驱动：仓库/端口/产物   │
 │  ├─ MEMORY.md 双向对账 + JSONL    │ │  ├─ 一级零损/二级批准/三级只读 │
 │  ├─ 只读：memory_recall/_profile  │ │  ├─ 只读：care_status（零啼哭）│
 │  └─ 独立侧栏：记忆库（asi-sleep） │ │  └─ 复用「生存需求」侧栏求助卡 │
 └───────────────────────────────────┘ └────────────────────────────────┘
```

### 已移除的旧版复杂度（0.2.0 起延续）

为保持纯粹的感官与需求分层，不包含：`WatchRule` / `env_watch` / `<env-update>` 动态消息推送、`Tuner` / `body_tune` 周桶基线学习、全盘 FSEvents 文件监视、30 天 JSONL 事件明细报告及插件源码自打包修改投递箱。

## 2. `asi-sense`：纯感官模块

### 2.1 采集范围与 Cordis 契约（`ctx.asiSense`）

1. **身体体征（`self.body`）**：`cpu`、`memory`、`disks`（含卷级新鲜度 `status`/`observedAt`/`ttlMs`）、`battery`、`thermal`、`network`、`harnessProcess`、`tokens`（含 `contextWindowSource`）。
2. **当前环境快照（`self` / `env` / `observation`）**：四节点位置链 `env.where`、前台应用、焦点窗口、DSH 活动任务、系统锁屏/休眠状态、辅助功能权限与信号源健康度。
3. **5 分钟短期趋势环（`BodyHistory`）**：内存环形缓冲保留最近 5 分钟体征序列（含 `diskFree` 剩余字节序列）。
4. **macOS Helper 瞬态 AX 稳定性契约**：`ax-retryable` 仅针对当前身份一致的前台应用将 `focusedWindow` 标为 `unknown`，不触发 helper 重启恢复。
5. **`AsiSenseService`（`ctx.asiSense`）**：提供 `snapshot`、`subscribe`、`setPowerMode('normal' | 'eco')`、`setPaused`、`setSendTitles`、`openPermissionSettings`、`registerInternalSession` 与 `refresh`。

## 3. `asi-needs`：生存需求、全景嗅探、行动记忆与多层仲裁

### 3.1 L1 五大生存需求与连续稳态回滞模型

每项需求实时计算整数 `satisfaction`（`0..100`）与 `urgency = 100 - satisfaction`，采用施密特触发器回滞（`<25` 为 `critical`，`<60` 为 `uncomfortable`，一旦 `driveActive` 激活须回升至 `>= 70` 才恢复 `comfortable` 并归档未决求助卡）：
- `energy`（能量）：电池电量/续航与模型网关连通性；
- `space`（空间）：新鲜磁盘卷剩余空间/占比与 5 分钟骤降斜率；
- `memory`（内存与进程）：系统内存压力、DSH RSS 与超时/无主 DSH 任务数；
- `mind`（心智容量）：上下文窗口余量与容量来源（区分已确认与 `fallback`）；
- `thermals`（体温负荷）：macOS `thermal` 档位与 2 分钟持续 CPU 负荷。

### 3.2 MIT 开源内化改造：全景病因嗅探与 1 小时保护期外部缓存批准清理

为实现零外部 CLI 依赖且天然通过沙盒与 `release-audit.mjs` 发布包审计，`asi-needs` 以源码级裁剪内化改造了以下 MIT 开源项目的核心规则与防护设计（详见 `LICENSE`）：
- **`bysiber/cleardisk`（MIT）**：macOS 开发者缓存目标分类字典与 `safe / caution / risky` 风险分级模型；
- **`guhcostan/mac-cleaner-cli`（MIT）**：构建/包管理缓存发现规则、符号链接零跟随与近期活跃修改保护策略；
- **`tw93/Mole`（MIT）**：集中式删除根路径校验器（`validateProtectedTargetRoot`），硬性拦截系统根、主目录根、用户文档/下载/凭据目录及废纸篓路径；
- **`sindresorhus/ps-list` & `soyuka/pidusage`（MIT）**：零第三方二进制依赖的 POSIX `ps` 进程表解析核心（仅提取可执行程序基名，不读取命令行参数明文，避免泄露敏感 token）。

工作流与安全边界：
1. **全景只读嗅探工具 `needs_sniff_causes`（仅挂载于后台自维护会话）**：
   - 按规则独立配额扫描受控字典内的外部开发者缓存（Xcode `DerivedData` / `Archives`、Homebrew、pnpm、npm、pip、uv、Cargo、Go Build/Mod、Gradle、Playwright 浏览器），防止大型包缓存目录耗尽配额饥饿后序规则，精确区分**总体积（`totalBytes`）**与**修改时间超过 1 小时的可清理体积（`reclaimableBytes`）**；
   - 只读统计系统废纸篓（`~/.Trash`）体积与项目数（独立配额、固定 `risk: 'risky'`、`cleanable: false`，仅作提示）；
   - 采样当前 Top CPU / Top RSS 进程摘要（仅供负载归因参考，绝不强杀外部进程）；
   - 全部输出统一经 `sanitizeForModel` 脱敏与 `~` 路径归一化，普通用户日常对话不挂载该工具。
2. **无人值守 vs 求助卡一键批准清理**：
   - 无人值守时，后台会话**仅自动清理 ASI 自身沙盒临时目录**（`needs_clean_cache`）；
   - 当检测到外部 `safe/caution` 缓存大户时，生成携带精确体积与**受控白名单 `actionTarget` 标识**（`actionKind: 'clean-external-cache'`，严格拒绝任意路径、`macos-trash` 或无超 1h 可清理字节的目标入参）的求助卡；多缓存大户场景下批准清理首项后若空间仍紧，自动顺延提议下一未忽略的可清理大户；
   - 用户在侧栏点击「批准清理外部缓存」时，宿主执行 `lstat`（防符号链接）+ `realpath` 包含校验 + `validateProtectedTargetRoot` 防护，**直接清除该目标内修改时间 `>= 1 小时`（`3,600,000 ms`）的陈旧缓存项以立即释放磁盘空间，并自动跳过最近 1 小时内刚修改过的活跃子项**（对 Xcode 工程工作区、`.xcarchive` / `.app` 包束、Playwright 浏览器目录与 `.cargo/git/db` 裸仓库按原子子项整体保护，防止半删损坏活跃编译或包束）。废纸篓、用户文件与外部进程永远只提示不代动。

### 3.3 行动效果记忆（Action-Outcome Memory）与零收益静默熔断

1. **宿主自动实测前后增益（`ActionMeasurement`）**：
   - 每次执行自维护工具、高阶需求沙盒工具或用户批准求助卡动作前后，宿主自动刷新感官并实测真实增益（`freedBytes`、`stoppedJobs`、`tokensSaved`、`satisfactionBefore -> satisfactionAfter` 提升 `satisfactionDelta`），写入维护记录与持久化 `state.json`。
2. **零收益静默熔断（`EpisodeCircuitBreaker`，省 Token）**：
   - 同一异常剧集内，若安全自救动作已试过但无实际收益（`!effective` 且满足度未提升）并且已挂出或已处理求助卡（或用户主动点击「忽略」），宿主自动对该需求启动**静默熔断**，不再每过 120 秒重复唤醒大模型空转；
   - 仅当出现以下任一事件时自动解除熔断：① 环境发生实质变化（如磁盘余量较熔断基线变化 `>= 512 MiB`、新增卡死任务/空闲可压缩会话、高阶需求 `evidence` 变更、满足度变化 `>= 10%`）；② 严重度从 `uncomfortable` 恶化升级至 `critical`；③ 用户点击求助卡「批准 / 我已处理」（触发单轮复核，若仍零收益则重新闭合熔断）；④ 需求恢复至 `comfortable` 舒适区。
3. **持久化动作收益账本（`ActionOutcomeLedger`）**：
   - 长期累计每个 `(需求 × 动作)` 的尝试次数、有效次数、有效率（`successRate`）与累计释放空间/节省 Token/满足度总增益；
   - 唤醒后台自维护会话时自动注入历史有效率推荐（优先推荐高收益动作、警示历史及近期零收益动作），并在统一侧栏「自发维护」面板实时展示。

### 3.4 跨插件统一需求仲裁服务（`ctx.asiDrives`）

`asi-needs` 直接向 Cordis 暴露 `ctx.asiDrives`（`AsiDrivesService`），内置马斯洛多层需求仲裁器（`MaslowDriveArbiter`）：
- **L1（生理生存层，内置）**：`asi-needs` 自身五大生存需求（`energy`、`space`、`memory`、`mind`、`thermals`）；
- **L2–L4（高阶需求层，开放扩展）**：支持独立组合包插件（如 L2 `asi-sleep` 离线记忆巩固、L3 `asi-care` 工作区与项目看护）调用 `ctx.asiDrives.registerSource({ id, tier: 2 | 3 | 4, label, evaluate, sandboxTools, executeHelpAction, onHelpDismissed })` 动态注册需求源、专属沙盒工具与受控求助卡批准回调（评估入参深拷贝隔离并在 `sendTitles=false` 时自动遮蔽窗口标题），并通过 `proposeHelpCard` / `resolveHelpCards` 在统一侧栏挂载静默求助卡（`silent: true`，严禁触发 `<asi-cry>` 对话注入），用户批准后自动计量真实收益写入 `ActionOutcomeLedger`；
- **生理优先、在途抢占与节能自动压制**：只要任一 L1 生理需求处于不适/危急/回滞恢复期，或 `asi-sense` 处于 `'eco'` 节能降频模式，所有 `L2–L4` 高阶需求均自动标记 `suppressed = true` 挂起——不仅阻止高阶后台唤醒、在 `agent.ctx.tools.guard` 层即时拦截高阶沙盒工具，还会通过专属 `AbortSignal` 立即抢占中断在途高阶维护回合（不误记高阶熔断、不挤占 L1 自救冷却）；待 L1 彻底恢复舒适且回到 `'normal'` 模式后，高阶需求按层级优先序共享同一后台自维护会话与每小时轮次预算，并自动接入统一侧栏与动作收益账本。

## 4. `asi-sleep`：L2 睡眠与长期记忆巩固

1. **开源算法复用与内化（MIT，零原生 C++ / 外部 CLI 依赖）**：
   - 改造自 `Fozikio/cortex-engine`（MIT）的双阶段睡眠整合流水线：**NREM 阶段**增量提炼并同批聚类四类记忆（`preference` 偏好、`decision` 决策、`pitfall` 踩坑、`episode` 近期进展）；**REM 阶段**跨会话去重强化、消解偏好/决策立场反转冲突、建立跨会话关联链接并按遗忘曲线修剪过期记忆。
   - 集成 `open-spaced-repetition/ts-fsrs`（MIT）计算连续时间幂律保留率 $R(t)$，命中 `memory_recall` 自动强化稳定度 $S$；手动置顶（`pinned: true`）条目恒定锁定 `100%` 保留率且永不衰减修剪。
   - 集成 `lucaong/minisearch`（MIT）并扩展中英双语二元词组 + 驼峰/代码标识符分词器，支持毫秒级本地 BM25 + 前缀 + 拼写容错检索。
   - 本地落盘为人类可直接查看并**双向编辑**的 `vault/MEMORY.md` + 结构化 `vault/memories.jsonl` + `vault/sleep-journal.jsonl`（外部手工编辑 `MEMORY.md` 在启动与读写/落盘前自动对账同步回 `memories.jsonl`，保留原有 FSRS 状态并强制脱敏）。
2. **困意曲线、静默窗口与生理抢占仲裁**：
   - 注册至 `ctx.asiDrives`（`id: 'asi-sleep', tier: 2`，`autoMaintain: false`），当普通对话未整合轮次 `>= 12`（或有新轮次且距上次睡眠 `>= 6 小时`）时进入不适区（`satisfaction < 60`）；
   - 严格跳过后台自维护沙盒与子代理（`subagent`）会话；
   - 自动睡眠仅在「全部普通会话空闲 `>= 10 分钟` 或 `env.system.locked === true`」且 L1 生理需求全部舒适（非 `eco` 模式）时启动，每日自动配额 `<= 6` 次；一旦在途出现 L1 生理不适或进入 `eco` 模式，立即通过 `AbortController` 抢占中断并回滚配额。
3. **零 Prompt Cache 污染的按需工具**：
   - 日常对话仅注册只读工具 `memory_recall` 与 `memory_profile`，绝不动态注入消息或改写系统提示词。

## 5. `asi-care`：L3 本地工作区与项目看护

`asi-care` 作为独立无侧栏图标的组合包接入 `ctx.asiDrives`（`tier: 3`），与监听外部远端工单的 `dsh-superagent` 及单会话 `dsh-context` 互补，专注本机工作区与多工作树卫生：
1. **零配置发现 + Git 兄弟工作树展开 + 2h 活跃豁免**：自动聚合 DSH `workspaceRegistry`、普通会话 `cwd` 与可选 `extraRoots`（排除 `ignorePaths`、ASI 内部目录及 `~/.secrets` / `~/.Trash`），通过 `git worktree list --porcelain` 自动展开全部兄弟工作树；凡有活跃 DSH 会话或 `2 小时` 内存在文件变动的工作树自动豁免扣分与清理。
2. **快慢双速探针与正交三分驱动**：快探针每 `3 分钟` 巡检 Git 状态/锁（带 `--no-optional-locks` / `GIT_OPTIONAL_LOCKS=0`）与 `lsof` 监听端口，慢探针每 `30 分钟` 按配额遍历非活跃工作树构建产物；输出 `repo_hygiene`、`orphan_runtime`、`workspace_bloat` 三条独立熔断的 L3 驱动。
3. **MIT 开源裁剪内化与三级自治护栏**：源码级内化改造 `npkill`、`simple-git`、`git-cleaner`、`fkill` / `pid-port` 解析与校验规则（零第三方运行时依赖）；一级无人值守仅执行 `git worktree prune`、经 `lsof` 复核零进程占用的超时 `.git/*.lock` 与无主 DSH 任务；二级清理 `>=7d` 闲置构建产物（`>=1 GiB` 不适）、移除 `>=3d` 干净已合入 worktree（不带 `--force`）及向 `>2h` 本地孤儿开发端口发送 `SIGTERM` 一律须用户点击侧栏静默求助卡批准；三级未提交改动（`>24h`）、未推送提交与冲突残留（`>2h`）永远只读提示。普通对话仅暴露只读工具 `care_status`，全程零 `<asi-cry>` 前台打扰。

## 6. 侧栏界面（`生存需求` + `记忆库`）

- **生存需求**（`id: 'asi-needs'`，`order: 90`）：置顶求助区（承载 L1 啼哭求助卡与 L3 `asi-care` 静默一键批准求助卡）、L1 五大生理需求与 `ctx.asiDrives` 高阶需求仲裁区（同步展示 L2 `asi-sleep` 与 L3 `asi-care` 满足度及挂起状态）、自发维护与动作收益账本、核心体征、当前环境、控制与隐私开关。
- **记忆库**（`id: 'asi-sleep'`，`order: 91`）：L2 睡眠稳态与配额卡片、「立即睡眠整合」与「暂停自动睡眠整合」开关、图形化中英搜索与四类记忆筛选、FSRS 保留率进度条，以及完整的记忆增删改与置顶（永不衰减）管理。

## 7. 隐私与凭据安全

- 所有观察数据、维护状态、动作收益账本与长期记忆库仅保存在本机 DSH 数据目录。
- 所有暴露给模型的工具返回值（`env_state`、`env_detail`、`needs_status`、`needs_sniff_causes`、`memory_recall`、`memory_profile`、`care_status`、维护工具及 `ctx.asiDrives` 扩展工具）、记忆落盘写入前与磁盘读取后，以及 `<asi-cry>` 文本一律经过线性时间 $O(N)$ 的 `sanitizeForModel` 凭据打码器与主目录 `~` 化保护；关闭「窗口标题发给模型」时，窗口标题既不发给模型也不渲染进侧栏 DOM。
- 发行包构建产物（`asi-sense`、`asi-needs`、`asi-sleep`、`asi-care`）均强制通过 `release-audit.mjs` 检查（校验文件白名单、零源码映射、零密钥/邮箱/本机用户名/敏感绝对路径残留）。
