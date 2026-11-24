# asi

`asi`（`0.7.0`）是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH `0.2.2-rc.3 || 0.2.2-rc.5`，macOS `arm64`）的**统一仿生稳态、自进化与 L5 高阶认知组合包插件**。

它在内部保持清晰的 L0–L5 八大仿生模块化架构，对外统一打包为单一发行包 `asi-0.7.0.tgz` 并在 DSH 左侧栏仅注册**唯一一个侧栏入口**（`id: 'asi'`，`order: 90`）：

1. **L0 感官采集（`src/sense/`，`ctx.asiSense`）**：采集本机身体体征（CPU、内存、磁盘、电源、温控、网络、进程、Token）、环境快照与最近 5 分钟短期趋势环，向日常对话暴露只读工具 `env_state` / `env_detail`（零动态事件注入）。
2. **L1 生存需求与马斯洛多层仲裁（`src/needs/`，`ctx.asiDrives`）**：连续评估五大基础生理需求（能量、空间、内存与进程、心智容量、体温负荷），驱动本能反射、后台自维护沙盒（`needs_sniff_causes` 等）、行动效果记忆与零收益静默熔断，并统一仲裁 L2–L4 高阶需求，向日常对话暴露只读工具 `needs_status`。
3. **L2 睡眠与记忆整合（`src/sleep/`，`ctx.asiSleep`）**：在对话满 12 轮或满 6 小时产生困意，于 10 分钟空闲或锁屏且 L1 舒适时自动运行仿生 NREM+REM 双阶段睡眠整合（结合 `ts-fsrs` 遗忘衰减与 `MiniSearch` 中英检索，支持 `MEMORY.md` 双向对账），向日常对话暴露只读工具 `memory_recall` / `memory_profile`。
4. **L3 工作区与项目看护（`src/care/`）**：零配置发现工作区并展开 Git 兄弟工作树，按 2 小时活跃豁免与三级安全护栏治理仓库卫生、孤儿开发端口与闲置构建产物，全程零 `<asi-cry>` 对话打断，向日常对话暴露只读工具 `care_status`。
5. **L4 技能提炼与自进化（`src/growth/`，`ctx.skills.registerProvider`）**：在 L1–L3 舒适且深静默（空闲 `>= 20 分钟` 或锁屏）时从高保留率踩坑记忆与排障轨迹提炼标准纯文本 `agentskills` `SKILL.md` 草案（含 `v1 → v2+` 差异对比），经人工一键批准后热挂载至 `ctx.skills`（支持 `global`/`workspace` 作用域隔离、一键导出至 `.agents/skills/` 与 60 天代谢提醒），向日常对话暴露只读工具 `growth_status`。
6. **前额叶直觉闪回与前瞻记忆（`src/intuition/`，`ctx.asiIntuition`）**：纯本地 `<10ms` 零 Token 匹配历史踩坑/关键决策躯体标记与工具重复报错疤痕，结合定时/情境/事件三类前瞻记忆触发器，以 `next-step` 静默尾部合并/撤回入队与 `pre-step` 同轮尾部挂载触达（零唤醒空闲会话、100% 保护前缀 Prompt Cache），嵌入「记忆库 → 直觉与前瞻」子分区及跨页焦点条，开放 `intuition_status`、`prospective_remember`、`prospective_resolve` 闭环工具。
7. **心智理论与协作眼力见（`src/tom/`，`ctx.asiTom`）**：零 Token 融合注意力拓扑与会话交互节律（个体 EWMA 基线归一化），实时推断搭档状态（`deep_focus` / `rapid_sprint` / `stuck_debugging` / `exploring` / `steady_flow` / `away_resting`）与四维指标，注册静默协作驱动 `asi-tom:social_tact`（`autoMaintain: false`）、静态提示词契约与按需只读工具 `partner_state`（100% 保护 Prompt Cache），并在统一侧栏提供透明一键校准闭环。
8. **DMN 睡眠做梦与跨项目顿悟（`src/dream/`，`ctx.asiDream`）**：在 L1–L3 舒适且深静默（空闲 `>= 15 分钟` 或锁屏）时跨独立 Git 仓库融合长期记忆、排障轨迹与只读结构画像，自动合成跨仓避坑预警、同构架构迁移、范式收敛与约定张力顿悟，在「记忆库 → 做梦顿悟」与顶部焦点条支持采纳为记忆、转交 L4 技能草案与忽略降权，向日常对话暴露只读工具 `dream_insights`。

## 无损数据自动迁移（`0.5.0` → `0.6.0+`）

默认数据根目录为 `~/.dsh/data/asi`（`cordis.patch.yml`：`dshHomePath('data', 'asi')`）。首次启动时，插件会在加载各层状态与记忆库前自动将同级旧版目录 `../asi-sense`、`../asi-needs`、`../asi-sleep`（含 `vault/memories.jsonl`、`vault/MEMORY.md`、`vault/sleep-journal.jsonl` 及 `state.json` 已整合会话水位线）、`../asi-care` 与 `../asi-growth` 无损迁移至 `~/.dsh/data/asi/{sense,needs,sleep,care,growth}`，同时在磁盘上完整保留旧目录作为安全回退备份。

## 隐私与安全默认项

- 观察数据、长期记忆库与技能文件仅保存在本机，日常对话仅通过只读工具按需读取，全链路经 `sanitizeForModel` 凭据打码器与主目录 `~` 化保护。
- 「窗口标题发给模型」默认开启，以便模型在按需查询环境时结合当前窗口上下文；用户可随时在侧栏顶部「设置」弹出层中关闭该开关或开启「暂停感知与自维护」，关闭该开关后窗口标题会立即对模型与界面隐藏。

## 常用开发命令

```sh
pnpm --filter asi run check
pnpm --filter asi run e2e
pnpm --filter asi run release:check
```
