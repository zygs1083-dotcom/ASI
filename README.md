# ASI

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的**统一仿生稳态、长期记忆巩固、工作区看护、程序性技能自进化与 L5 高阶认知（前额叶直觉前瞻、心智理论协作眼力见、DMN 睡眠做梦跨仓顿悟）插件**（单一组合包 [`asi`](plugins/asi/README.md)，当前版本 **`0.7.0`**）。

对外仅需安装一个发行包 `asi-0.7.0.tgz`，在 DSH 左侧栏仅注册**唯一一个侧栏图标**（**ASI 稳态**，`id: 'asi'`，`order: 90`），内部则严格保持 L0–L5 八大仿生模块解耦分工，并在首次启动时自动将旧版 `0.5.0` 五插件数据（`~/.dsh/data/asi-*`，含全部长期记忆与会话整合水位线）无损迁移至 `~/.dsh/data/asi/{sense,needs,sleep,care,growth}`。

## 内部 L0–L5 模块架构（`asi@0.7.0`）

| 层级 | 模块目录 | 核心职责与服务 | 日常对话工具 |
|---|---|---|---|
| **L0 感官** | `plugins/asi/src/sense/` | 采集本机身体体征（CPU、内存、磁盘、电源、温控、网络、进程、Token）、环境快照与 5 分钟短期趋势环，暴露 `ctx.asiSense`，零动态事件消息注入 | `env_state`、`env_detail` |
| **L1 生存稳态** | `plugins/asi/src/needs/` | 连续回滞评估五大生理需求（能量、空间、内存与进程、心智容量、体温负荷）；本能反射、全景病因嗅探（`needs_sniff_causes`）、行动收益账本与零收益熔断；暴露 `ctx.asiDrives` 马斯洛多层仲裁器 | `needs_status` |
| **L2 睡眠记忆** | `plugins/asi/src/sleep/` | 对话满 12 轮或满 6h 产生困意，于 10m 空闲/锁屏且 L1 舒适时自动执行 NREM+REM 睡眠整合（上限 6 次/日）；结合 `ts-fsrs` 与 `MiniSearch` 维护偏好/决策/踩坑/进展记忆库与 `MEMORY.md` 双向对账，暴露只读 `ctx.asiSleep` | `memory_recall`、`memory_profile` |
| **L3 工作区看护** | `plugins/asi/src/care/` | 零配置发现工作区并展开 Git 兄弟工作树，2h 活跃豁免，快慢双速探针治理仓库卫生、孤儿开发端口与闲置构建产物（一级零损自治、二级静默求助卡批准、三级只读提示），全程零 `<asi-cry>` 打扰 | `care_status` |
| **L4 技能自进化** | `plugins/asi/src/growth/` | L1–L3 舒适且深静默（空闲 `>= 20m` 或锁屏）时从高保留率踩坑记忆与复现排障轨迹提炼纯文本 `agentskills` `SKILL.md`（上限 2 份/日，支持 `v1 → v2+` 差异检查）；经人工批准后热挂载至 `ctx.skills`（支持 `global`/`workspace` 隔离、导出 `.agents/skills/` 与 60 天代谢提醒） | `growth_status` |
| **L5 前额叶直觉与前瞻** | `plugins/asi/src/intuition/` | 纯本机 `<10ms` 零 Token 躯体标记闪回与重复报错疤痕，结合定时/情境/事件前瞻记忆触发器，以 `next-step` 尾部原位合并/撤回与 `pre-step` 尾部挂载触达（100% 保护 Prompt Cache），暴露 `ctx.asiIntuition` | `intuition_status`、`prospective_remember`、`prospective_resolve` |
| **L5 心智理论（ToM）** | `plugins/asi/src/tom/` | 零 Token 融合注意力拓扑与交互节律（个体 EWMA 基线），实时推断六种搭档认知状态与四维指标，提供协作处方、免扰避让信号与一键校准，暴露 `ctx.asiTom` | `partner_state` |
| **L5 DMN 做梦顿悟** | `plugins/asi/src/dream/` | L1–L3 舒适且空闲 `>= 15m` 或锁屏时跨独立 Git 仓库结构画像与记忆远距联想（上限 3 次/日），合成避坑预警、同构迁移、范式收敛与约定张力顿悟并联通记忆库/技能草案，暴露 `ctx.asiDream` | `dream_insights` |

## 统一侧栏界面（`id: 'asi'`，`order: 90`）

- **顶部全局状态胶囊**：一眼查看整体稳态、搭档认知状态徽章（如 `搭档·心流`）、节能/暂停/仅本机隐私标识，以及一键展开的全局暂停与窗口标题隐私开关弹出层。
- **跨 Tab 待批焦点条**：按马斯洛优先级（求助卡 -> 到期前瞻意图 -> 待审技能草案 -> 跨项目做梦顿悟）在任意非当前视图顶部展示一键处理或一键跳转提示条。
- **`稳态看护 | 记忆库 | 技能工坊` 三段导航**：「稳态看护」含 L1 生存稳态、搭档协作感知（`<TomCard />`）与 L2–L5 高阶仲裁；「记忆库」内置 `长期记忆 | 直觉与前瞻 | 做梦顿悟` 三子分区；低频原始身体体征、5 分钟趋势曲线与历史日志默认折叠在底部抽屉中按需展开。

共享工作区库位于 `packages/`：`@asi/sense-types`（共享类型契约与 `sanitizeForModel` 凭据脱敏）、`@asi/body-probe`（macOS 体征探针）与 `@asi/sense-ui`（体征、环境与稳态基础视图组件）。

## 兼容性与文档

- **兼容宿主**：DeepSeek Harness `0.2.2-rc.3 || 0.2.2-rc.5`（Apple Silicon macOS `arm64`，Node `^22.12.0 || ^24.0.0 || >=26.0.0`）
- **插件说明**：[plugins/asi/README.md](plugins/asi/README.md)
- **架构设计**：[docs/DESIGN.md](docs/DESIGN.md)
- **安装、迁移与升级指南**：[docs/install-and-update.md](docs/install-and-update.md)
- **打包审计与发布流程**：[docs/release.md](docs/release.md)
- **协作与安全规范**：[AGENTS.md](AGENTS.md)（日常开发门禁执行 `pnpm check` 与 `pnpm run e2e`）

## License

MIT（含内化改造与复用的 MIT 开源规则及组件署名，详见 [LICENSE](LICENSE) 与 [plugins/asi/README.md](plugins/asi/README.md)）
