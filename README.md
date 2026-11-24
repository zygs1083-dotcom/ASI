# ASI

一组模块化 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）组合包插件，完整实现从本机感官采集、L1 生理生存需求稳态评估、L2 仿生睡眠长期记忆巩固、L3 本地工作区多工作树看护到 L4 程序性技能提炼与自进化的马斯洛五插件架构。插件之间仅通过 Cordis 服务（`ctx.asiSense` / `ctx.asiDrives` / `ctx.asiSleep`）与共享类型契约协作；`asi-sense` 与 `asi-care` 作为无独立侧栏图标的后台组合包运行，`asi-needs`、`asi-sleep` 与 `asi-growth` 在 DSH 左侧栏依次注册 **生存需求**（`order: 90`）、**记忆库**（`order: 91`）与 **技能工坊**（`order: 92`）三个面板。

## 核心插件（`0.5.0`）

| 插件 | 角色与职责 | 侧栏 UI | 说明 |
|---|---|---|---|
| [`asi-sense`](plugins/asi-sense/README.md) | **纯感官模块**：采集本机身体体征（电源、内存、磁盘、CPU、温控、网络、DSH 进程、Token）、当前环境快照与最近 5 分钟短期趋势环，提供 `ctx.asiSense` 服务及只读工具 `env_state` / `env_detail`，绝不主动向对话注入动态事件消息 | 无（纯后台服务） | `0.5.0` |
| [`asi-needs`](plugins/asi-needs/README.md) | **L1 生存需求、自发维护与多层驱动仲裁**：订阅 `ctx.asiSense`，实时评估五大 L1 生理需求（能量、空间、内存与进程、心智容量、体温负荷）；内置后台全景只读病因嗅探（`needs_sniff_causes`）、求助卡一键批准外部开发者缓存清理（含 1 小时活跃保护期）、行动效果记忆（Action-Outcome Memory）与零收益静默熔断，并暴露 `ctx.asiDrives` 跨插件马斯洛多层仲裁服务与全局只读工具 `needs_status` | **生存需求**（`id: 'asi-needs'`，`order: 90`） | `0.5.0` |
| [`asi-sleep`](plugins/asi-sleep/README.md) | **L2 睡眠与记忆整合**：接入 `ctx.asiDrives`（`tier: 2`），在对话满 12 轮或满 6 小时产生困意，仅在空闲满 10 分钟或锁屏且 L1 舒适时自动运行仿生 NREM+REM 双阶段睡眠整合（上限 6 次/天）；基于 `ts-fsrs` 遗忘衰减与 `MiniSearch` 中英全文检索维护偏好/决策/踩坑/近期进展四类可读 Markdown/JSONL 记忆库，暴露只读 `ctx.asiSleep` 服务与按需只读工具 `memory_recall` / `memory_profile` | **记忆库**（`id: 'asi-sleep'`，`order: 91`） | `0.5.0` |
| [`asi-care`](plugins/asi-care/README.md) | **L3 工作区与项目看护**：接入 `ctx.asiDrives`（`tier: 3`），零配置聚合本地工作区与自动展开 Git 兄弟工作树，按快慢双速探针（3m/30m）与 2h 活跃豁免评估三条正交 L3 驱动（`repo_hygiene` / `orphan_runtime` / `workspace_bloat`）；复用「生存需求」侧栏静默求助卡与动作收益账本承载二级一键批准，全程零 `<asi-cry>` 对话打断，仅向普通对话暴露只读工具 `care_status` | 复用「生存需求」侧栏（无新增图标） | `0.5.0` |
| [`asi-growth`](plugins/asi-growth/README.md) | **L4 技能提炼与自进化**：接入 `ctx.asiDrives`（`tier: 4`）与只读 `ctx.asiSleep`，当同主题积累 `>= 3` 条高保留率踩坑/决策/偏好记忆或 `>= 2` 次多步排障轨迹时产生自进化驱动，仅在 L1–L3 全部舒适且空闲 `>= 20 分钟` 或锁屏时自动起草纯文本 `agentskills` `SKILL.md`（上限 2 份/天，支持 `v1 → v2+` 修订对比）；经人工一键批准后通过 `ctx.skills.registerProvider` 热挂载（支持 `global`/`workspace` 作用域隔离、一键导出至 `.agents/skills/` 与 60 天零调用代谢提醒），向普通对话暴露只读工具 `growth_status` | **技能工坊**（`id: 'asi-growth'`，`order: 92`） | `0.5.0` |

共享工作区库位于 `packages/`：`@asi/sense-types`（感官、生存需求、行动效果记忆、`ctx.asiDrives` 与 `ctx.asiSleep` 共享契约及凭据脱敏）、`@asi/body-probe`（macOS 体征探针）与 `@asi/sense-ui`（统一 `NeedsPanel` 界面组件）。

## 兼容性与文档

- **兼容宿主**：DeepSeek Harness `0.2.2-rc.3 || 0.2.2-rc.5`（Apple Silicon macOS `arm64`，Node `^22.12.0 || ^24.0.0 || >=26.0.0`）
- **架构设计**：[docs/DESIGN.md](docs/DESIGN.md)
- **安装与升级指南**：[docs/install-and-update.md](docs/install-and-update.md)
- **打包审计与发布流程**：[docs/release.md](docs/release.md)
- **协作与安全规范**：[AGENTS.md](AGENTS.md)（日常开发门禁执行 `pnpm check`）

## License

MIT（含内化改造与复用的 MIT 开源规则及组件署名，详见 [LICENSE](LICENSE)、[plugins/asi-needs/README.md](plugins/asi-needs/README.md)、[plugins/asi-sleep/README.md](plugins/asi-sleep/README.md)、[plugins/asi-care/README.md](plugins/asi-care/README.md) 与 [plugins/asi-growth/README.md](plugins/asi-growth/README.md)）
