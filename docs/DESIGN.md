# ASI 设计文档（v0.6 · 单插件五层稳态、无损数据迁移与统一侧栏架构）

状态：v0.6 定稿（2026-11-24）。在 v0.5 五插件马斯洛体系基础上，将五个拆分组合包整合收敛为**单一 DSH 组合包 `asi`（`0.6.0`）**，内置从旧版 `../asi-*` 目录到 `~/.dsh/data/asi/{sense,needs,sleep,care,growth}` 的启动期无损非破坏性数据迁移，并将原有的三个独立侧栏图标统一重设计为**唯一侧栏入口「ASI 稳态」（`id: 'asi'`，`order: 90`）**。

## 0. 兼容版本

- **DSH 宿主**：支持的宿主版本恰为 `0.2.2-rc.3` 与 `0.2.2-rc.5`；各包 `engines.dsh` 与 `@deepseek-ai/dsh-*` `peerDependencies` 统一声明 `0.2.2-rc.3 || 0.2.2-rc.5`。开发构建固定针对 `0.2.2-rc.3` 源码提交 `39163dd30f703a79079e2d2446545cff3c453738` 验证。
- **Node**：`^22.12.0 || ^24.0.0 || >=26.0.0`；macOS 原生辅助进程使用 Swift（Apple Silicon `arm64`）。
- **宿主已知约束**：
  - `ctx.llm.resolveModelInfo` 与 `sessionProjections` 在未显式携带来源时返回回退估值，Token 事实统一附带 `contextWindowSource: 'configured' | 'catalog' | 'fallback'`；`fallback` 在侧栏标注「容量未确认（回退估值）」，在心智需求评估中偏紧时仅进入 `uncomfortable` 后台静默整理，避免误报危急啼哭。

## 1. 核心理念与单包五层总体架构

`asi`（`0.6.0`）对外是一个自包含 DSH 组合包（包含 `lib/index.js`、`lib/client.js`、`lib/typert.host.js`、`lib/asi-sense-helper`、`cordis.patch.yml`、`scripts/dsh.sh`、`LICENSE`、`package.json`），内部按 L0–L4 五层清晰解耦并通过 Cordis 服务（`ctx.asiSense`、`ctx.asiDrives`、`ctx.asiSleep`、`ctx.asi`）协作：

```
┌────────────────────────────────────────────────────────────────────────────┐
│ asi（0.6.0 · 单一 DSH 组合包 · storageRoot: ~/.dsh/data/asi）              │
│  ├─ Step 0 启动迁移：migrateLegacyAsiData (../asi-* -> sense..growth)      │
│  ├─ L0 src/sense（ctx.asiSense + env_state / env_detail）                  │
│  │    └─ Swift AX helper + BodyProbe + 5m BodyHistory 短期趋势环           │
│  ├─ L1 src/needs（ctx.asiDrives 马斯洛仲裁器 + needs_status）              │
│  │    └─ 五大生理需求回滞模型 + 本能反射/自维护沙盒/求助卡 + 收益账本熔断  │
│  ├─ L2 src/sleep（tier: 2 · ctx.asiSleep + memory_recall / memory_profile）│
│  │    └─ >=12 轮或 >=6h 困意 -> 10m 静默窗 NREM+REM + ts-fsrs + MiniSearch │
│  ├─ L3 src/care（tier: 3 · care_status）                                   │
│  │    └─ 多工作树发现 + 2h 活跃豁免 + 仓库卫生/孤儿端口/闲置产物三级护栏   │
│  ├─ L4 src/growth（tier: 4 · ctx.skills.registerProvider + growth_status） │
│  │    └─ L1-L3 舒适 + 20m 深静默 -> 纯文本 SKILL.md 草案 -> 人工批准热挂载 │
│  └─ 统一 TypeRT 服务 ctx.asi + 唯一侧栏面板（id: 'asi', order: 90）        │
└────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 启动期无损旧版数据迁移（`migrateLegacyAsiData`）

- `cordis.patch.yml` 配置 `storageRoot: !!js dshHomePath('data', 'asi')`（默认 `~/.dsh/data/asi`）。
- 在各层运行时加载状态与记忆库之前，自动检查同级旧目录 `../asi-sense`、`../asi-needs`、`../asi-sleep`、`../asi-care`、`../asi-growth`：
  - 若目标子目录 `<storageRoot>/<module>` 尚无实时数据且旧目录为真实目录（`lstat` 严格拦截符号链接与越界路径，跳过 `sandbox`/`tmp`/`cache`/`*.tmp`），则原子复制全部持久化文件（含 `asi-sleep` 的 `vault/memories.jsonl`、`vault/MEMORY.md`、`vault/sleep-journal.jsonl` 以及 `state.json` 中的 `consolidatedSessionWatermarks` 与 `consolidatedTurnKeys`，确保现有长期记忆 100% 无损保留且历史已整合会话绝不重复整合）并写入 `.migration-v1.json` 幂等标记；
  - 旧版 `../asi-*` 目录在磁盘上**原封不动保留**，供用户随时安全回退。

### 1.2 已移除的旧版复杂度（0.2.0 起延续）

不包含：`WatchRule` / `env_watch` / `<env-update>` 动态消息推送、`Tuner` / `body_tune` 周桶基线学习、全盘 FSEvents 文件监视、30 天 JSONL 事件明细报告及插件源码自打包修改投递箱。

## 2. L0 感官模块（`src/sense/`）

1. **身体体征（`self.body`）**：`cpu`、`memory`、`disks`（含卷级新鲜度 `status`/`observedAt`/`ttlMs`）、`battery`、`thermal`、`network`、`harnessProcess`、`tokens`（含 `contextWindowSource`）。
2. **当前环境快照（`self` / `env` / `observation`）**：四节点位置链 `env.where`、前台应用、焦点窗口、DSH 活动任务、系统锁屏/休眠状态、辅助功能权限与信号源健康度。
3. **5 分钟短期趋势环（`BodyHistory`）**：内存环形缓冲保留最近 5 分钟体征序列（含 `diskFree` 剩余字节序列）。
4. **macOS Helper 瞬态 AX 稳定性契约**：`ax-retryable` 仅针对当前身份一致的前台应用将 `focusedWindow` 标为 `unknown`，不触发 helper 重启恢复。
5. **`AsiSenseService`（`ctx.asiSense`）**：提供 `snapshot`、`subscribe`、`setPowerMode('normal' | 'eco')`、`setPaused`、`setSendTitles`、`openPermissionSettings`、`registerInternalSession` 与 `refresh`。

## 3. L1 生存需求与多层仲裁（`src/needs/`）

1. **五大生存需求与连续稳态回滞模型**：每项需求实时计算整数 `satisfaction`（`0..100`）与 `urgency = 100 - satisfaction`，采用施密特触发器回滞（`<25` 为 `critical`，`<60` 为 `uncomfortable`，一旦 `driveActive` 激活须回升至 `>= 70` 才恢复 `comfortable` 并归档未决求助卡）：`energy`、`space`、`memory`、`mind`、`thermals`。
2. **全景病因嗅探与 1 小时活跃保护外部缓存批准清理**：内化改造 `bysiber/cleardisk`、`guhcostan/mac-cleaner-cli`、`tw93/Mole`、`sindresorhus/ps-list` 与 `soyuka/pidusage`（均 MIT）。无人值守仅清理 ASI 自有沙盒临时目录；外部开发者缓存须由用户点击求助卡批准后清理修改时间 `>= 1 小时` 的陈旧项；废纸篓、用户文件与外部进程永远只读提示。
3. **行动效果记忆（`ActionOutcomeLedger`）与零收益静默熔断**：实测动作前后真实增益并持久化 `(需求 × 动作)` 有效率账本；同一异常剧集内安全自救零收益且已挂出求助卡时启动静默熔断。
4. **马斯洛多层仲裁服务（`ctx.asiDrives`）**：统一纳管 L1–L4 需求；只要任一 L1 生理需求处于不适/危急/回滞恢复期或处于 `'eco'` 模式，所有 `L2–L4` 高阶需求自动标记 `suppressed = true` 挂起并抢占中断在途高阶回合。

## 4. L2 睡眠与长期记忆巩固（`src/sleep/`）

1. **开源算法复用与内化（MIT）**：改造自 `Fozikio/cortex-engine`（NREM+REM 双阶段整合）、`open-spaced-repetition/ts-fsrs`（FSRS 保留率衰减与回忆强化）与 `lucaong/minisearch`（中英双语全文检索），本地持久化为 `<storageRoot>/sleep/vault/{MEMORY.md,memories.jsonl,sleep-journal.jsonl}`。
2. **困意曲线、静默窗口与只读 `ctx.asiSleep`**：普通对话未整合轮次 `>= 12` 或有新轮次且距上次睡眠 `>= 6 小时` 时产生困意，仅在全部普通会话空闲 `>= 10 分钟` 或锁屏且 L1 舒适时自动整合（`<= 6` 次/天）；向 L4 暴露零副作用只读 `ctx.asiSleep`，向日常对话仅注册按需只读工具 `memory_recall` 与 `memory_profile`。

## 5. L3 本地工作区与项目看护（`src/care/`）

内化改造 `npkill`、`simple-git`、`git-cleaner`、`fkill` / `pid-port`（均 MIT）：零配置发现工作区并展开 Git 兄弟工作树，2h 活跃工作树自动豁免，按 3m/30m 双速探针输出 `repo_hygiene`、`orphan_runtime`、`workspace_bloat` 三条正交驱动；一级零损无人值守（`git worktree prune`、零占用超时 `.git/*.lock`、无主 DSH 任务），二级（闲置构建产物、干净已合入 worktree、孤儿开发端口 `SIGTERM`）通过静默求助卡由用户一键批准，三级未提交改动/冲突永远只读提示；普通对话仅暴露只读工具 `care_status`。

## 6. L4 程序性技能提炼与自进化（`src/growth/`）

1. **纯文本标准格式（MIT）**：改造自 `MineDojo/Voyager` 与 `agentskills/agentskills`，所有草案、已启用技能与归档技能均以纯文本 `SKILL.md` 存储在 `<storageRoot>/growth/skills/{drafts,active,archived}/`，强拦截任何可执行脚本生成引用与未授权工作区写入。
2. **高证据阈值与 20 分钟深静默门控**：融合 `ctx.asiSleep` 高保留率（`>= 0.5` 或置顶）记忆与多步排障轨迹，仅当 L1–L3 全部舒适且全部普通会话空闲 `>= 20 分钟` 或锁屏时自动起草待审草案（`<= 2` 份/日，在途遇 L1–L3 激活立即抢占中断并回滚配额）。
3. **人工批准热挂载与 60 天代谢**：新技能（`v1`）与增量修订（`v2+` 行级差异对比）一律须用户点击「批准启用」后才通过 `ctx.skills.registerProvider` 热挂载，支持 `global`/`workspace`（`cwd`）作用域在线切换、一键导出至 `.agents/skills/<name>/SKILL.md` 及连续 `60` 天零调用代谢归档建议；普通对话仅暴露只读工具 `growth_status`。

## 6B. 方向 B：心智理论——搭档状态感知与协作眼力见（`src/tom/`）

1. **零 Token 确定性推断与个体节律 EWMA 基线**：纯本机融合 `ctx.asiSense` 注意力拓扑（应用类别驻留、5 分钟切换熵、锁屏/休眠）与普通会话交互动力学（发信间隔、指令精炼度、主动打断 `interrupted`、回合/命令非零退出、审批延迟），按个体 EWMA 节律基线归一化推断六种搭档认知状态（`deep_focus`、`rapid_sprint`、`stuck_debugging`、`exploring`、`steady_flow`、`away_resting`）及四维连续指标（`focus`、`friction`、`pace`、`presence`）；持久化于 `<storageRoot>/tom/state.json`，绝不存储对话原文、窗口标题或路径历史。
2. **100% Prompt Cache 保护与默契适应处方（`TactGuidance`）**：注册字节恒定的静态 `systemPrompt` 引导段（`asi-tom`）与按需只读工具 `partner_state`（可选只读联动 `ctx.asiSleep` 高保留率协作偏好，全链路经 `sanitizeForModel` 脱敏），指导模型默契调整回复详略度、验证姿态与澄清问题预算，严禁生硬点破推断情绪。
3. **静默马斯洛协同与透明一键校准**：暴露 `ctx.asiTom` 服务（含 `shouldDeferProactiveWork()` 免扰避让信号），并向 `ctx.asiDrives` 注册 `tier: 3` 静默社交驱动 `asi-tom:social_tact`（`autoMaintain: false`，零后台 LLM 唤醒、零 `<asi-cry>`）；在侧栏顶部状态胶囊与「稳态看护」独立卡片 `<TomCard />` 中支持 60 分钟手动覆写与在线校准偏置学习。

## 7. 统一侧栏界面（`id: 'asi'`，`order: 90`）

通过单一 `AsiRemote`（`ctx.asi`）合并推送 `{ needs, sleep, growth }` 实时帧，采用统一 CSS Module 设计系统（消费宿主 `--dsw-*` 明暗令牌，`color-mix` 高对比度状态墨色，严格 `320px` 零水平溢出与 `axe-core` 零违规）：

1. **顶部全局状态胶囊**：展示整体稳态胶囊（`稳态舒适 / 存在不适 / 生存危急 / 恢复保持`）、`节能` / `已暂停` / `仅本机` 标签，以及一键展开的全局暂停与窗口标题隐私开关弹出层。
2. **三段式 Tab 导航（`稳态看护` | `记忆库` | `技能工坊`）**：支持完整 WAI-ARIA `tablist` 键盘方向键切换与实时待办/计数角标。
3. **跨 Tab 待批焦点条（Spotlight Strip）**：当存在未处理看护求助卡或待审 `SKILL.md` 新草案时，在非当前所属 Tab 顶部自动展示醒目操作条，支持原位一键批准或一键跳转审阅。
4. **减法留白与低频抽屉收折**：
   - `稳态看护` 主屏仅呈现未决求助卡、L1 五大需求紧凑进度行、L2–L4 仲裁摘要与自检入口；「维护账本与历史记录」、「原始身体体征与 5m 趋势」、「当前环境与信号源」全部默认折叠在底部抽屉中按需展开；
   - `记忆库` 提供紧凑睡眠状态栏、搜索与分类胶囊筛选、整洁记忆卡片（FSRS 保留率、置顶标识、长文展开、内联增删改）及默认折叠的睡眠日志抽屉；
   - `技能工坊` 提供紧凑 L4 状态栏、`待审草案 / 已启用 / 已归档` 筛选、`v1 → v2` 差异视图、`SKILL.md` 在线预览与校验编辑、作用域切换、一键导出至 `.agents/skills/` 及默认折叠的提炼日志抽屉。

## 8. 隐私与凭据安全

- 所有观察数据、维护状态、动作收益账本、长期记忆库与技能文件仅保存在本机 `~/.dsh/data/asi/`（除用户显式点击导出技能至指定工作区 `.agents/skills/` 外，绝不写入用户项目目录）。
- 所有暴露给模型的工具返回值、`ctx.skills` 技能内容、记忆与 `SKILL.md` 落盘前后、RPC 错误信息及 `<asi-cry>` 文本一律经过线性时间 $O(N)$ 的 `sanitizeForModel` 凭据打码器与主目录 `~` 化保护，并严格跳过所有 ASI 内部沙盒/记忆库/技能目录（含旧版 `data/asi-*` 目录）及子代理会话。
- 单一发行包构建产物（`plugins/asi/dist/asi-0.6.0.tgz`）强制通过 `release-audit.mjs` 检查（校验文件白名单、零源码映射、零密钥/邮箱/本机用户名/敏感绝对路径残留）。
