# ASI 设计文档（v0.5 · 五插件稳态、睡眠记忆巩固、本地工作区看护与程序性技能自进化架构）

状态：v0.5 定稿（2026-11-24）。在 v0.4 四插件基础上，正式集成 **L4 技能提炼与自进化插件 `asi-growth`**（独立「技能工坊」侧栏，`order: 92`）并在 `asi-sleep` 上暴露只读 Cordis 服务 `ctx.asiSleep`，完成从感官、生理稳态（L1）、长期记忆巩固（L2）、工作区看护（L3）到程序性技能自进化（L4）的完整马斯洛五插件体系。

## 0. 兼容版本

- **DSH 宿主**：支持的宿主版本恰为 `0.2.2-rc.3` 与 `0.2.2-rc.5`；各包 `engines.dsh` 与 `@deepseek-ai/dsh-*` `peerDependencies` 统一声明 `0.2.2-rc.3 || 0.2.2-rc.5`。开发构建固定针对 `0.2.2-rc.3` 源码提交 `39163dd30f703a79079e2d2446545cff3c453738` 验证。
- **Node**：`^22.12.0 || ^24.0.0 || >=26.0.0`；macOS 原生辅助进程使用 Swift（Apple Silicon `arm64`）。
- **宿主已知约束**：
  - `ctx.llm.resolveModelInfo` 与 `sessionProjections` 在未显式携带来源时返回回退估值，Token 事实统一附带 `contextWindowSource: 'configured' | 'catalog' | 'fallback'`；`fallback` 在侧栏标注「容量未确认（回退估值）」，在心智需求评估中偏紧时仅进入 `uncomfortable` 后台静默整理，避免误报危急啼哭。

## 1. 核心理念与总体分工

ASI 由 `asi-sense`、`asi-needs`、`asi-sleep`、`asi-care` 与 `asi-growth` 五个独立组合包构成，插件之间仅通过 Cordis 服务（`ctx.asiSense`、`ctx.asiDrives`、`ctx.asiSleep`）与 `@asi/sense-types` 共享契约通信，不互相引用内部源码：

 ```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ asi-sense（0.5.0 · 纯感官模块 · 无侧栏 UI · 后台 Cordis 服务）            │
 │  ├─ 信号源：macOS Swift helper / BodyProbe / DSH 活动与任务               │
 │  ├─ 状态库：SenseState（每条事实含来源、时间、TTL 与权限状态）             │
 │  ├─ 短期趋势环：BodyHistory（内存保留最近 5 分钟体征曲线）                 │
 │  ├─ Cordis 服务：ctx.asiSense（快照、订阅、normal/eco 采样）              │
 │  └─ 全局只读工具：env_state / env_detail（绝不主动注入消息）               │
 └────────────────────────────────────┬─────────────────────────────────────┘
                                      │ ctx.asiSense.subscribe / setPowerMode
                                      ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ asi-needs（0.5.0 · L1 生存需求、行动记忆与多层需求仲裁 · 生存需求侧栏）    │
 │  ├─ L1 五大生理需求稳态评估（0..100% 满足度/紧迫度 + 回滞锁）：           │
 │  │    ① 能量 energy  ② 空间 space  ③ 内存与进程 memory                   │
 │  │    ④ 心智容量 mind ⑤ 体温负荷 thermals                                 │
 │  ├─ Cordis 跨插件仲裁服务：ctx.asiDrives（马斯洛 L1–L4 仲裁器）           │
 │  │    - 供高阶插件（L2 asi-sleep、L3 asi-care、L4 asi-growth）注册需求源  │
 │  │    - L1 生理不适或 eco 节能模式时自动压制挂起全部 L2–L4 高阶需求       │
 │  ├─ 三层自救与交互机制：本能反射 / 独立自维护沙盒 / 按需啼哭与批准求助卡   │
 │  ├─ 行动效果记忆（Action-Outcome Memory）与零收益静默熔断                 │
 │  ├─ 普通对话只读工具：needs_status                                        │
 │  └─ 侧栏面板（id: 'asi-needs', order: 90）：生存需求/高阶仲裁/自维护/环境 │
 └────────────┬───────────────────────────┬──────────────────────────┬──────┘
              │ tier: 2                   │ tier: 3                  │ tier: 4 (+ ctx.asiSleep)
              ▼                           ▼                          ▼
 ┌──────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────────┐
 │ asi-sleep（0.5.0 · L2）  │ │ asi-care（0.5.0 · L3）  │ │ asi-growth（0.5.0 · L4）    │
 │  ├─ >=12 轮或 >=6h 困意  │ │  ├─ 零配置 + 兄弟工作树 │ │  ├─ >=3 高保留记忆或 >=2 轨迹│
 │  ├─ 10m 空闲/锁屏静默窗  │ │  ├─ 3m/30m 探针+2h豁免  │ │  ├─ L1-L3 全舒适 + 20m/锁屏 │
 │  ├─ NREM+REM + ts-fsrs   │ │  ├─ 仓库/端口/产物三分  │ │  ├─ 纯文本 SKILL.md (<=2/日)│
 │  ├─ 暴露只读 ctx.asiSleep│ │  ├─ 一级零损/二级静默卡 │ │  ├─ 人工批准 -> ctx.skills  │
 │  ├─ memory_recall/_profile│ │  ├─ 只读：care_status  │ │  ├─ 60天代谢 + 导出 .agents │
 │  └─ 记忆库（order: 91）  │ │  └─ 复用生存需求求助卡  │ │  └─ 技能工坊（order: 92）   │
 └──────────────────────────┘ └─────────────────────────┘ └─────────────────────────────┘
 ```

### 已移除的旧版复杂度（0.2.0 起延续）

为保持纯粹的感官与需求分层，不包含：`WatchRule` / `env_watch` / `<env-update>` 动态消息推送、`Tuner` / `body_tune` 周桶基线学习、全盘 FSEvents 文件监视、30 天 JSONL 事件明细报告及插件源码自打包修改投递箱。

## 2. `asi-sense`：纯感官模块

1. **身体体征（`self.body`）**：`cpu`、`memory`、`disks`（含卷级新鲜度 `status`/`observedAt`/`ttlMs`）、`battery`、`thermal`、`network`、`harnessProcess`、`tokens`（含 `contextWindowSource`）。
2. **当前环境快照（`self` / `env` / `observation`）**：四节点位置链 `env.where`、前台应用、焦点窗口、DSH 活动任务、系统锁屏/休眠状态、辅助功能权限与信号源健康度。
3. **5 分钟短期趋势环（`BodyHistory`）**：内存环形缓冲保留最近 5 分钟体征序列（含 `diskFree` 剩余字节序列）。
4. **macOS Helper 瞬态 AX 稳定性契约**：`ax-retryable` 仅针对当前身份一致的前台应用将 `focusedWindow` 标为 `unknown`，不触发 helper 重启恢复。
5. **`AsiSenseService`（`ctx.asiSense`）**：提供 `snapshot`、`subscribe`、`setPowerMode('normal' | 'eco')`、`setPaused`、`setSendTitles`、`openPermissionSettings`、`registerInternalSession` 与 `refresh`。

## 3. `asi-needs`：生存需求、全景嗅探、行动记忆与多层仲裁

### 3.1 L1 五大生存需求与连续稳态回滞模型

每项需求实时计算整数 `satisfaction`（`0..100`）与 `urgency = 100 - satisfaction`，采用施密特触发器回滞（`<25` 为 `critical`，`<60` 为 `uncomfortable`，一旦 `driveActive` 激活须回升至 `>= 70` 才恢复 `comfortable` 并归档未决求助卡）：`energy`、`space`、`memory`、`mind`、`thermals`。

### 3.2 MIT 开源内化改造：全景病因嗅探与 1 小时保护期外部缓存批准清理

源码级内化改造 `bysiber/cleardisk`、`guhcostan/mac-cleaner-cli`、`tw93/Mole`、`sindresorhus/ps-list` 与 `soyuka/pidusage`（均 MIT，详见 `LICENSE`）。无人值守仅清理 ASI 自有沙盒目录（`needs_clean_cache`）；外部 `safe/caution` 开发者缓存须由用户点击求助卡批准后清理修改时间 `>= 1 小时` 的陈旧项（保护最近 1 小时活跃子项与原子工程/包束）；废纸篓、用户文件与外部进程永远只读提示。

### 3.3 行动效果记忆（`ActionOutcomeLedger`）与零收益静默熔断

自动实测动作前后真实增益并持久化 `(需求 × 动作)` 有效率账本；同一异常剧集内安全自救零收益且已挂出求助卡时启动静默熔断，仅在环境实质变化、升级至 `critical`、用户批准处理或恢复舒适时解除。

### 3.4 跨插件统一需求仲裁服务（`ctx.asiDrives`）

内置马斯洛多层仲裁器（`MaslowDriveArbiter`），统一纳管 L1 生理生存需求与高阶插件（L2 `asi-sleep`、L3 `asi-care`、L4 `asi-growth`）：只要任一 L1 生理需求处于不适/危急/回滞恢复期或处于 `'eco'` 模式，所有 `L2–L4` 高阶需求均自动标记 `suppressed = true` 挂起并抢占中断在途高阶回合。

## 4. `asi-sleep`：L2 睡眠与长期记忆巩固

1. **开源算法复用与内化（MIT）**：改造自 `Fozikio/cortex-engine`（NREM+REM 双阶段整合）、`open-spaced-repetition/ts-fsrs`（FSRS 保留率衰减与回忆强化）与 `lucaong/minisearch`（中英双语全文检索），本地持久化为支持双向编辑对账的 `vault/MEMORY.md` + `vault/memories.jsonl` + `vault/sleep-journal.jsonl`。
2. **困意曲线、静默窗口与只读 Cordis 服务（`ctx.asiSleep`）**：
   - 注册至 `ctx.asiDrives`（`id: 'asi-sleep', tier: 2, autoMaintain: false`），普通对话未整合轮次 `>= 12` 或有新轮次且距上次睡眠 `>= 6 小时` 时产生困意，仅在全部普通会话空闲 `>= 10 分钟` 或锁屏且 L1 舒适时自动整合（`<= 6` 次/天）；
   - 向同进程上层插件（如 `asi-growth`）暴露只读 `AsiSleepServiceApi`（`ctx.asiSleep.listMemories` / `subscribe`，零 FSRS 状态副作用、全字段脱敏隔离），向日常对话仅注册按需只读工具 `memory_recall` 与 `memory_profile`。

## 5. `asi-care`：L3 本地工作区与项目看护

无独立侧栏图标的组合包接入 `ctx.asiDrives`（`tier: 3`），源码级内化改造 `npkill`、`simple-git`、`git-cleaner`、`fkill` / `pid-port`（均 MIT）：零配置发现工作区并展开 Git 兄弟工作树，2h 活跃工作树自动豁免，按 3m/30m 双速探针输出 `repo_hygiene`、`orphan_runtime`、`workspace_bloat` 三条正交驱动；一级零损无人值守（`git worktree prune`、零占用超时 `.git/*.lock`、无主 DSH 任务），二级（闲置构建产物、干净已合入 worktree、孤儿开发端口 `SIGTERM`）复用「生存需求」静默求助卡由用户批准，三级未提交改动/冲突永远只读提示；普通对话仅暴露只读工具 `care_status`。

## 6. `asi-growth`：L4 程序性技能提炼与自进化

1. **MIT 开源复用改造与纯文本标准格式（零原生 C++ / 外部 CLI 依赖）**：
   - 改造自 `MineDojo/Voyager`（MIT）的程序性技能库闭环（`高证据聚类 -> 技能起草 -> 验证评论家 Critic -> v1->v2+ 增量迭代精炼`）；
   - 改造自 `agentskills/agentskills`（MIT）的开放标准 `SKILL.md` YAML Frontmatter + Markdown 解析、序列化与规范校验器（强校验 kebab-case `name` `1..64` 字符、`description` `10..1024` 字符，硬性拦截任何 `scripts/*.sh|*.mjs|*.py` 可执行脚本生成引用）。
   - 所有草案、已启用技能与归档技能均以纯文本 `SKILL.md` 存储在 `<storageRoot>/skills/{drafts,active,archived}/`，**零可执行脚本生成、零未获用户点击导出的 Git 工作区写入**。
2. **高证据阈值、20 分钟深静默门控与跨层抢占（`ctx.asiDrives` L4）**：
   - 注册 `id: 'asi-growth', tier: 4`（`autoMaintain: false`）与沙盒工具 `growth_synthesize`；
   - 融合 `ctx.asiSleep` 高保留率（`retention >= 0.5` 或置顶）记忆（仅计 `pitfall`/`decision`/`preference`，`episode` 永不触发）与已完成的普通会话多步排障轨迹（`>= 2` 步或工具调用且解决报错）：仅当同一主题累积 `>= 3` 条高保留率记忆（含至少 1 条 `pitfall`）**或**多步排障轨迹重复出现 `>= 2` 次（或已启用技能主题出现新踩坑触发 `v2+` 修订）时才进入不适区（`satisfaction < 60`）；
   - **深静默自动起草门控**：仅当 **L1（`asi-needs`）、L2（`asi-sleep`）与 L3（`asi-care`）全部处于舒适区**（非 `eco` 模式）**且**全部普通会话空闲 `>= 20 分钟` 或屏幕已锁定时自动起草待审草案（每日自动上限 `<= 2` 份）；在途若任一 L1–L3 驱动激活或进入 `eco` 模式，立即通过 `AbortController` 抢占中断并回滚当日自动配额。
3. **严格人工批准门禁、`@deepseek-ai/dsh-skill` 动态热挂载与 60 天代谢**：
   - 新技能（`v1`）与增量修订（`v2+`，侧栏内置行级 `+`/`-` 差异对比器）一律先落入「待审草案」，绝不自动生效；
   - 用户一键点击「批准启用」后，通过 DSH 公开接口 `ctx.skills.registerProvider` 即时调用 `control.invalidate()` 热挂载/热更新至宿主技能目录，支持 `global`（全局）与 `workspace`（按 `options.cwd` 严格隔离）作用域在线切换，以及由用户一键安全导出至目标工作区 `.agents/skills/<name>/SKILL.md`（含 `lstat` 符号链接拦截与受保护根路径校验）；
   - 自动统计每项技能的调用次数、最近调用时间与关联回合完成率；对连续 `60` 天零调用的已启用技能自动标记「建议归档」，一键归档即从 `ctx.skills` 卸载并保留文件供随时恢复。普通对话仅注册只读工具 `growth_status`（零动态提示词或消息注入）。

## 7. 侧栏界面（`生存需求` + `记忆库` + `技能工坊`）

三个客户端面板均采用独立 CSS Module 文件与类名前缀隔离（`asi-needs`、`asi-sleep`、`asi-growth` 样式选择器 100% 零重叠）：
- **生存需求**（`id: 'asi-needs'`，`order: 90`）：置顶求助区（承载 L1 啼哭求助卡与 L3 `asi-care` 静默批准卡）、L1 五大生理需求与 `ctx.asiDrives` 高阶需求仲裁区（实时同步展示 L2 `asi-sleep`、L3 `asi-care` 与 L4 `asi-growth` 满足度及挂起状态）、自发维护与动作收益账本、核心体征、当前环境、控制与隐私开关。
- **记忆库**（`id: 'asi-sleep'`，`order: 91`）：L2 睡眠稳态与配额卡片、「立即睡眠整合」与「暂停自动睡眠整合」开关、图形化中英搜索与四类记忆筛选、FSRS 保留率进度条，以及完整的记忆增删改与置顶管理。
- **技能工坊**（`id: 'asi-growth'`，`order: 92`）：L4 自进化与 20m 深静默门控卡片、「立即提炼技能」与「暂停自动技能提炼」开关、`待审草案 / 已启用 / 已归档` 三视图切换、`SKILL.md` 在线预览与实时规范校验编辑、`v1 → v2` 增量修订差异检查、`global` 与 `workspace`（`cwd`）作用域切换、批准/驳回/停用/归档/恢复、手动新建草案，以及一键导出至 `.agents/skills/`。

## 8. 隐私与凭据安全

- 所有观察数据、维护状态、动作收益账本、长期记忆库与技能工坊文件仅保存在本机 DSH 数据目录（除用户显式点击导出技能至指定工作区 `.agents/skills/` 外，绝不写入用户项目目录）。
- 所有暴露给模型的工具返回值（`env_state`、`env_detail`、`needs_status`、`needs_sniff_causes`、`memory_recall`、`memory_profile`、`care_status`、`growth_status`、维护工具及 `ctx.asiDrives` 扩展工具）、`ctx.skills` 返回的技能描述与正文、记忆与 `SKILL.md` 落盘前后、RPC 错误信息及 `<asi-cry>` 文本一律经过线性时间 $O(N)$ 的 `sanitizeForModel` 凭据打码器与主目录 `~` 化保护，并严格跳过所有 ASI 内部沙盒/记忆库/技能目录及子代理会话。
- 五个发行包构建产物（`asi-sense`、`asi-needs`、`asi-sleep`、`asi-care`、`asi-growth`）均强制通过 `release-audit.mjs` 检查（校验文件白名单、零源码映射、零密钥/邮箱/本机用户名/敏感绝对路径残留）。
