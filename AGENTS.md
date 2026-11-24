# ASI 项目规则（AGENTS.md）

本项目只按本文件协作，**不套用全局 mesh 规则**（U1/U3/MacAir 分工、hub 钩子 CI、三条通道等都不适用）。
所有 agent（协调端和 worker）开工前先读本文件和 `docs/DESIGN.md`；做到具体插件时再读该插件目录下的 `README.md`。

## 1. 产品范围

ASI 是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）的**单一统一组合包插件 `asi`（当前版本 `0.6.0`）**。对外分发为单一发行包 `plugins/asi/dist/asi-0.6.0.tgz`（`dsh plugin add` 安装），在 DSH 左侧栏仅注册**唯一一个侧栏入口**「ASI 稳态」（`id: 'asi'`，`order: 90`），并在启动时将旧版五插件目录 `../asi-{sense,needs,sleep,care,growth}` 无损迁移至 `~/.dsh/data/asi/{sense,needs,sleep,care,growth}`（原目录完整保留作回退备份）。

插件内部严格保持清晰的 L0–L4 五层模块化设计（详细设计见 `docs/DESIGN.md` 与 `plugins/asi/README.md`）：

1. **L0 感官模块（`src/sense/`，`ctx.asiSense`）**：采集本机身体体征（电源、内存、磁盘、CPU、温控、网络、进程、Token）、当前环境快照（位置链、前台应用窗口、活动任务、系统/权限状态）与最近 5 分钟短期趋势环，向对话暴露只读工具 `env_state` / `env_detail`（含脱敏与隐私开关保护），绝不主动向对话注入动态事件消息。
2. **L1 生存需求与多层仲裁（`src/needs/`，`ctx.asiDrives`）**：订阅 `ctx.asiSense`，按连续稳态张力与回滞模型实时评估五大基础生理需求（能量、空间、内存与进程、心智容量、体温负荷）；通过「零 Token 本能反射 + 独立后台自维护会话（含全景只读病因嗅探 `needs_sniff_causes` 与白名单安全沙盒工具） + 行动效果记忆与零收益静默熔断 + 按需啼哭求助（`<asi-cry>` 与支持 1 小时活跃保护的一键外部缓存批准求助卡）」自主维护运行环境；直接暴露 `ctx.asiDrives` 马斯洛多层需求仲裁服务（L1 生理不适或 `eco` 模式自动压制挂起 L2–L4 高阶需求）及全局只读工具 `needs_status`。
3. **L2 睡眠与记忆整合（`src/sleep/`，`ctx.asiSleep`）**：接入 `ctx.asiDrives`（`tier: 2`），在普通对话累计 `>= 12` 轮或间隔 `>= 6h`（有新轮次）时产生睡眠困意，仅在会话空闲 `>= 10 分钟` 或锁屏且 L1 生理需求全部舒适时自动执行仿生 NREM+REM 双阶段睡眠记忆整合（自动上限 `<= 6` 次/天，L1 不适或 `eco` 模式即时压制/抢占中断）；结合 `ts-fsrs` 遗忘衰减与 `MiniSearch` 中英检索维护偏好（`preference`）、决策（`decision`）、踩坑（`pitfall`）、近期进展（`episode`）四类本地可读 Markdown/JSONL 记忆库（支持 `MEMORY.md` 双向编辑对账），暴露只读 `ctx.asiSleep` 服务与按需只读工具 `memory_recall` / `memory_profile`（零动态注入、100% 保护 Prompt Cache）。
4. **L3 工作区与项目看护（`src/care/`）**：零配置发现 DSH `workspaceRegistry` 与会话 `cwd` 并自动展开 Git 兄弟工作树；通过 `ctx.asiDrives`（`tier: 3`）注册三条正交 L3 驱动（`repo_hygiene` / `orphan_runtime` / `workspace_bloat`，独立熔断，2h 活跃豁免）；按三级护栏自治（一级无人值守仅做 `git worktree prune`、经 `lsof` 复核零进程占用的陈旧 Git 锁与无主 DSH 任务；二级闲置构建产物、干净已合入 worktree 与本地孤儿开发端口 `SIGTERM` 一律通过静默求助卡由用户一键批准；三级未提交改动/未推送/冲突永远只读提示），全程禁用 `<asi-cry>` 对话打断，普通对话仅暴露只读工具 `care_status`。
5. **L4 技能提炼与自进化（`src/growth/`，`ctx.skills.registerProvider`）**：接入 `ctx.asiDrives`（`tier: 4`）与只读 `ctx.asiSleep`，融合高保留率踩坑/决策/偏好记忆（同主题 `>= 3` 条且含踩坑）与重复多步排障轨迹（`>= 2` 次），仅当 L1–L3 需求全部舒适（非 `eco` 模式）且会话空闲 `>= 20 分钟` 或锁屏时自动起草标准纯文本 `agentskills` `SKILL.md`（上限 `<= 2` 份/天，零可执行脚本生成、零未授权工作区写入）；严守「先起草（含 `v2+` 增量修订差异对比）→ 人工一键批准 → 通过 `@deepseek-ai/dsh-skill` `ctx.skills.registerProvider` 热挂载（支持 `global` 与 `workspace` `cwd` 作用域隔离及一键导出至 `.agents/skills/<name>/SKILL.md`）」，标记 `60` 天零调用陈旧技能建议归档，普通对话仅暴露只读工具 `growth_status`。
6. **DMN 默认模式网络：睡眠做梦与跨项目顿悟（`src/dream/`，`ctx.asiDream`）**：接入 `ctx.asiDrives`（`tier: 4`）与只读 `ctx.asiSleep`，通过 Git 工作树 `commondir` 归并不同仓库身份并结合非源码只读结构画像（`package.json` / `AGENTS.md` / 顶层目录），在 L1–L3 舒适且会话空闲 `>= 15 分钟` 或锁屏时执行跨仓库远距同构采样与做梦合成（上限 `<= 3` 次/天），输出跨仓避坑预警、同构架构迁移、跨项目范式收敛与约定张力四类顿悟，暴露只读工具 `dream_insights`（零动态注入、100% 保护 Prompt Cache）并在「记忆库 -> 做梦顿悟」与顶部焦点条支持一键固化为记忆、转交 L4 技能草案或忽略降权。
7. **统一侧栏界面（`id: 'asi'`，`order: 90`）**：采用「顶部全局状态胶囊 + 跨 Tab 待批焦点条 + `稳态看护 | 记忆库 | 技能工坊` 分段导航」，主卡片留白克制，低频原始体征与历史日志默认收起按需展开。

新增插件或扩大范围，须由协调端写进本文件和设计文档。

不做：修改 DSH 本体（不 fork、不打补丁，只用公开扩展点）；云同步、账号；默认截图或录屏；清空废纸篓、删除用户文件、无人值守清理外部开发者缓存、强杀外部应用或修改系统级配置；把观察数据发往本机以外的任何地方（模型请求除外，且受隐私开关与作用域护栏控制）。

## 2. 角色

| 角色 | 谁 | 职责 |
|---|---|---|
| 负责人 | 用户 | 产品决策、批准对外操作（push GitHub、发布插件） |
| 协调端 | U2 上的 Claude（仓库 `/home/desktop/pro/ASI`） | 设计、写契约和任务说明、派发、裁决评审、合并 `main`、汇报 |
| 开发 worker | **默认 U1 上的 agy Gemini 4 Hydrogen XHigh**（负责人 2026-11-17 定，`ASI_HOST=U1 dispatch.sh <task> hydrogen …`） | 在自己的工作树/分支实现、自测、提交、push 到 hub |
| 测试/评审 worker | **默认 U1 上的 Hydrogen**（新会话、未参与实现）；只有必须在 macOS/真实 DSH 里做的验收，暂由 MacPro 上的 devin `swe-2` 承担（MacPro 上 agy 被 Google 地区限制） | 写测试、在真实 DSH 里验收、独立评审（只读代码） |

- worker 在 **U1**（Linux，纯逻辑与单测）和 **MacPro**（macOS API、真实 DSH 验收）上运行，合计**同时最多 5 个**；U1 磁盘紧张，同时不超过 3 个。
- 协调端不在 worker 工作树里改代码；worker 不替负责人做产品决策，口径不清用 `orca orchestration ask` 问。
- 评审 worker 必须是新会话、没参与实现。

## 3. 派发方式（协调端）

```bash
/home/desktop/pro/ASI-work/dispatch.sh <task> <dev|test> <spec 绝对路径> [基线分支，默认 hub/main]
```

脚本会在 MacPro 建工作树、按模型启动 devin（并自动处理首启主题提示），再执行 `worker-start`。任务说明写在 `/home/desktop/pro/ASI-work/<task>_spec.md`（仓库外），必须自包含：基线、Target、Change、Constraints、Ownership、Observable acceptance、交付格式。派完后在后台挂 `orca orchestration check --wait ...` 等消息，不轮询 worker 屏幕。worker 完成后，协调端负责释放 worker、关闭终端、删除工作树。

## 4. Git

- 中转仓库（hub）是 U2 上的 `ssh://desktop@100.108.45.41/home/desktop/pro/ASI`，MacPro 克隆里的 remote 名为 `hub`。
- worker 从 `hub/main` 拉分支 `task/<name>`，**只允许** `git push hub task/<name>`。禁止 push `main`、禁止 push `origin`/GitHub、禁止 force、禁止改写已 push 的历史。
- 协调端在 U2 评审后合入 `main`。推 GitHub 由负责人决定。
- 提交信息：`<type>: <摘要>`（feat/fix/test/docs/chore/refactor），小步提交。

## 5. 技术栈与命令

- 与 DSH 一致：TypeScript、Node ≥22、**pnpm** workspace（提交 `pnpm-lock.yaml`）、Cordis 插件模型、vitest。macOS 原生部分用 Swift（Apple Command Line Tools）。
- 目录：`plugins/<插件名>/` 下每个子目录是一个 DSH 组合包；`packages/` 放插件之间共享的库（例如状态模型类型）。
- 命令（M0 定稿后补全，届时以本表为准）：

| 命令 | 内容 | 谁跑 |
|---|---|---|
| `pnpm check` | typecheck + lint + 单测 | 每个 worker 交付前必跑，必须 0 退出 |
| `pnpm e2e` | 在 MacPro 上的真实 DSH 里加载插件并验收 | 测试 worker；开发 worker 改了界面或投递逻辑时跑相关用例 |

- DSH 本体只作为依赖或外部安装使用，版本固定写在 `docs/DESIGN.md` 的「兼容版本」一节。

## 6. 安全与隐私

- 观察数据（应用名、窗口标题、文件路径、进程信息）只留在本机。普通对话不主动注入环境动态，仅在按需调用只读工具（`env_state` / `env_detail` / `needs_status` / `memory_recall` / `memory_profile` / `care_status` / `growth_status`）或触发后台自维护时读取，且经过 `sanitizeForModel` 脱敏；用户可以在 `asi` 统一侧栏顶部「设置」弹出层随时暂停自发维护或关掉「窗口标题发给模型」。
- 默认不截图、不录屏、不读窗口内容。需要细节时调用 DSH 现有的 computer-use 能力，并遵守它的授权流程。
- 原生 helper 只申请必需的权限（辅助功能）。没有权限时降级为 `denied` 状态并在侧栏引导用户授权，不弹系统对话框轰炸用户。
- 测试不使用任何真实 API Key，不读 `~/.secrets/`，不连公司生产环境（192.168.0.34/.35）。需要真实模型时，只用 MacPro 本机的 magpie 网关 `http://127.0.0.1:3425/v1`（不需要 key），每个任务说明里写清楚允许发多少条请求。
- 日志、截图、测试夹具里不得出现 key、邮箱、真实窗口标题等个人信息，夹具一律用编造的数据。
- **发给模型的路径口径（负责人 2026-11-18 定）**：目录名、文件路径、用户名可以出现在发给模型的内容里（现有的主目录 `~` 化、白名单投影保留，不再追加新的路径识别）。评审定级：路径/目录名/用户名进入模型请求记 `should-fix`，不挡合并；`blocker` 只限：密钥/token/密码/邮箱/文件内容/截图被发出、崩溃、数据丢失、主线程 >200ms、内存 >50MB、违反产品口径（如重复推送、无异常也推送、漏推真实异常）。

## 7. worker 交付要求

- 结束时恰好发一次 `worker_done`，带 `--outcome succeeded|failed`。
- 交付说明 ≤20 行：做了什么 / 怎么验证（命令 + 真实结果）/ 没做或有疑问。
- 评审报告首行写 `verdict: pass` 或 `verdict: fix`，每条发现标 `blocker|should-fix|nit` 并给出 `文件:行号`。
- 完成即停，不在 MacPro 留后台进程（DSH 实例、helper、watcher 都要关掉）。
